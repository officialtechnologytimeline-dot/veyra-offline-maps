#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const COORDINATE_SCALE = 10_000_000;
const LENGTH_SCALE = 10;

const EDGE_FLAG = {
  oneWay: 1 << 0,
  roundabout: 1 << 1,
  tunnel: 1 << 2,
  bridge: 1 << 3,
  toll: 1 << 4,
  unpaved: 1 << 5,
  driveway: 1 << 6,
  parkingAisle: 1 << 7,
};

const ROAD_CLASS = {
  motorway: 0,
  motorway_link: 1,
  trunk: 2,
  trunk_link: 3,
  primary: 4,
  primary_link: 5,
  secondary: 6,
  secondary_link: 7,
  tertiary: 8,
  tertiary_link: 9,
  unclassified: 10,
  residential: 11,
  living_street: 12,
  service: 13,
  road: 14,
  track: 15,
  path: 16,
  pedestrian: 17,
};

const ACCESS_CODE = {
  yes: 1,
  permissive: 2,
  designated: 3,
  official: 3,
  destination: 4,
  delivery: 5,
  customers: 6,
  private: 7,
  no: 8,
  agricultural: 9,
  forestry: 10,
  permit: 11,
};

const BASE_ROUTABLE_HIGHWAYS = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'road',
  'track',
]);

const CONDITIONAL_HIGHWAYS = new Set(['path', 'pedestrian', 'busway']);
const EXPLICIT_MOTOR_ACCESS = new Set([
  'yes',
  'permissive',
  'designated',
  'official',
  'destination',
  'delivery',
  'customers',
]);
const UNPAVED_SURFACES = new Set([
  'unpaved',
  'compacted',
  'dirt',
  'earth',
  'fine_gravel',
  'gravel',
  'grass',
  'grass_paver',
  'ground',
  'mud',
  'pebblestone',
  'sand',
  'woodchips',
]);

function usage() {
  return `
Build a compact directed routing graph from a saved Overpass JSON response.

Usage:
  node scripts/build-routing-graph.mjs \\
    --input data/osm/torino-routing-20260725.json \\
    --output data/generated/torino-routing-20260725.graph.json \\
    --id it-piemonte-torino \\
    --revision 20260725

The builder never calls Overpass. It consumes only the pinned local input,
refuses to overwrite outputs, and emits JSON, JSON.gz and a SHA-256 manifest.
`.trim();
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid argument near "${key ?? ''}".`);
    }
    values.set(key, value);
    index += 1;
  }
  const input = values.get('--input');
  const output = values.get('--output');
  const id = values.get('--id');
  const revision = values.get('--revision');
  if (!input || !input.endsWith('.json')) {
    throw new Error('--input must point to a saved Overpass JSON file.');
  }
  if (!output || !output.endsWith('.graph.json')) {
    throw new Error('--output must end in .graph.json.');
  }
  if (!id || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id)) {
    throw new Error('--id must be a lowercase filesystem-safe identifier.');
  }
  if (!revision || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(revision)) {
    throw new Error('--revision contains unsupported characters.');
  }
  return {
    inputPath: resolve(input),
    outputPath: resolve(output),
    gzipPath: `${resolve(output)}.gz`,
    manifestPath: `${resolve(output)}.manifest.json`,
    id,
    revision,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function haversineDistanceM(a, b) {
  const radius = 6_371_008.8;
  const toRadians = (value) => (value * Math.PI) / 180;
  const latitude1 = toRadians(a[1]);
  const latitude2 = toRadians(b[1]);
  const latitudeDelta = latitude2 - latitude1;
  const longitudeDelta = toRadians(b[0] - a[0]);
  const sinLatitude = Math.sin(latitudeDelta / 2);
  const sinLongitude = Math.sin(longitudeDelta / 2);
  const value =
    sinLatitude * sinLatitude +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      sinLongitude *
      sinLongitude;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(value)));
}

function numericOsmId(value, context) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${context} has an unsafe OSM identifier.`);
  }
  return value;
}

function explicitMotorAccess(tags) {
  return ['motorcar', 'hgv', 'motor_vehicle', 'vehicle'].some((key) =>
    EXPLICIT_MOTOR_ACCESS.has(String(tags[key] ?? '').toLowerCase()),
  );
}

function isRoutableWay(tags) {
  if (!tags || tags.area === 'yes') return false;
  const highway = tags.highway;
  if (BASE_ROUTABLE_HIGHWAYS.has(highway)) return true;
  if (CONDITIONAL_HIGHWAYS.has(highway)) return explicitMotorAccess(tags);
  return false;
}

function accessCode(value) {
  if (typeof value !== 'string') return 0;
  return ACCESS_CODE[value.trim().toLowerCase()] ?? 0;
}

function packAccess(tags) {
  return (
    accessCode(tags.access) |
    (accessCode(tags.vehicle) << 4) |
    (accessCode(tags.motor_vehicle) << 8) |
    (accessCode(tags.motorcar) << 12) |
    (accessCode(tags.hgv) << 16)
  );
}

function parseMetricLength(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  const text = String(value).trim().toLowerCase().replace(',', '.');
  if (
    text === '' ||
    [
      'default',
      'below_default',
      'none',
      'unsigned',
      'unknown',
    ].includes(text)
  ) {
    return 0;
  }
  const feetInches = text.match(
    /^(\d+(?:\.\d+)?)\s*(?:ft|feet|')\s*(\d+(?:\.\d+)?)?\s*(?:in|")?$/,
  );
  if (feetInches) {
    return (
      Number(feetInches[1]) * 0.3048 +
      Number(feetInches[2] ?? 0) * 0.0254
    );
  }
  const inches = text.match(/^(\d+(?:\.\d+)?)\s*(?:in|")$/);
  if (inches) return Number(inches[1]) * 0.0254;
  const metric = text.match(/^(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)?$/);
  return metric ? Number(metric[1]) : 0;
}

function parseMetricWeight(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  const text = String(value).trim().toLowerCase().replace(',', '.');
  const match = text.match(
    /^(\d+(?:\.\d+)?)\s*(t|tonnes?|tons?|kg|kilograms?|lbs?|pounds?)?$/,
  );
  if (!match) return 0;
  const number = Number(match[1]);
  const unit = match[2] ?? 't';
  if (unit.startsWith('kg') || unit.startsWith('kilogram')) return number;
  if (unit.startsWith('lb') || unit.startsWith('pound')) {
    return number * 0.45359237;
  }
  return number * 1000;
}

function parseMaxSpeed(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  const candidates = String(value)
    .toLowerCase()
    .split(';')
    .map((item) => item.trim());
  const speeds = [];
  for (const candidate of candidates) {
    if (candidate === 'walk') {
      speeds.push(5);
      continue;
    }
    const match = candidate.match(/^(\d+(?:\.\d+)?)\s*(mph|knots?)?$/);
    if (!match) continue;
    const number = Number(match[1]);
    const unit = match[2];
    speeds.push(
      unit === 'mph' ? number * 1.609344 : unit?.startsWith('knot') ? number * 1.852 : number,
    );
  }
  return speeds.length > 0 ? Math.round(Math.min(...speeds)) : 0;
}

function oneWayDirection(tags) {
  const value = String(tags.oneway ?? '').toLowerCase();
  if (value === '-1' || value === 'reverse') return 'reverse';
  if (['yes', '1', 'true'].includes(value)) return 'forward';
  if (['no', '0', 'false', 'alternating'].includes(value)) return 'both';
  if (
    tags.junction === 'roundabout' ||
    tags.junction === 'circular' ||
    tags.highway === 'motorway' ||
    tags.highway === 'motorway_link'
  ) {
    return 'forward';
  }
  return 'both';
}

function edgeFlags(tags, oneWay) {
  let flags = oneWay === 'both' ? 0 : EDGE_FLAG.oneWay;
  if (tags.junction === 'roundabout' || tags.junction === 'circular') {
    flags |= EDGE_FLAG.roundabout;
  }
  if (tags.tunnel === 'yes' || tags.covered === 'yes') flags |= EDGE_FLAG.tunnel;
  if (tags.bridge === 'yes') flags |= EDGE_FLAG.bridge;
  if (tags.toll === 'yes') flags |= EDGE_FLAG.toll;
  if (UNPAVED_SURFACES.has(tags.surface)) flags |= EDGE_FLAG.unpaved;
  if (tags.service === 'driveway') flags |= EDGE_FLAG.driveway;
  if (tags.service === 'parking_aisle') flags |= EDGE_FLAG.parkingAisle;
  return flags;
}

function normalizeRestriction(elements, nodeIndex, includedWays, stats) {
  const restrictions = [];
  for (const relation of elements) {
    if (relation.type !== 'relation' || relation.tags?.type !== 'restriction') {
      continue;
    }
    const maneuver = relation.tags.restriction;
    if (
      typeof maneuver !== 'string' ||
      (!maneuver.startsWith('no_') && !maneuver.startsWith('only_'))
    ) {
      stats.unsupportedTurnRestrictions += 1;
      continue;
    }
    const fromWays = relation.members
      .filter((member) => member.type === 'way' && member.role === 'from')
      .map((member) => member.ref);
    const toWays = relation.members
      .filter((member) => member.type === 'way' && member.role === 'to')
      .map((member) => member.ref);
    const viaWays = relation.members
      .filter((member) => member.type === 'way' && member.role === 'via')
      .map((member) => member.ref);
    const viaNodes = relation.members
      .filter((member) => member.type === 'node' && member.role === 'via')
      .map((member) => member.ref);

    if (
      fromWays.length === 0 ||
      toWays.length === 0 ||
      (viaWays.length === 0 && viaNodes.length !== 1) ||
      (viaWays.length > 0 && viaNodes.length > 0) ||
      !fromWays.every((wayId) => includedWays.has(wayId)) ||
      !toWays.every((wayId) => includedWays.has(wayId)) ||
      !viaWays.every((wayId) => includedWays.has(wayId))
    ) {
      stats.unsupportedTurnRestrictions += 1;
      continue;
    }
    const viaNode =
      viaNodes.length === 1 ? nodeIndex.get(viaNodes[0]) : undefined;
    if (viaNodes.length === 1 && viaNode === undefined) {
      stats.unsupportedTurnRestrictions += 1;
      continue;
    }
    const except =
      typeof relation.tags.except === 'string'
        ? relation.tags.except
            .split(/[;,]/)
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined;

    for (const fromWayId of fromWays) {
      for (const toWayId of toWays) {
        restrictions.push({
          relationId: numericOsmId(relation.id, 'restriction relation'),
          kind: maneuver.startsWith('only_') ? 'only' : 'no',
          maneuver,
          fromWayId,
          toWayId,
          ...(viaNode === undefined ? {} : { viaNode }),
          ...(viaWays.length === 0 ? {} : { viaWayIds: viaWays }),
          ...(except?.length ? { except } : {}),
        });
      }
    }
  }
  return restrictions;
}

function validateBuiltGraph(graph) {
  if (graph.nodes.length === 0 || graph.edges.length === 0) {
    throw new Error('Generated graph is empty.');
  }
  for (let edgeId = 0; edgeId < graph.edges.length; edgeId += 1) {
    const edge = graph.edges[edgeId];
    if (
      edge[0] < 0 ||
      edge[1] < 0 ||
      edge[0] >= graph.nodes.length ||
      edge[1] >= graph.nodes.length ||
      edge[0] === edge[1] ||
      edge[4] <= 0
    ) {
      throw new Error(`Generated edge ${edgeId} is invalid.`);
    }
  }
}

async function refuseExisting(paths) {
  for (const path of paths) {
    try {
      await stat(path);
      throw new Error(`Refusing to overwrite existing output: ${path}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function atomicWrite(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, value, { flag: 'wx' });
  await rename(temporary, path);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await refuseExisting([
    options.outputPath,
    options.gzipPath,
    options.manifestPath,
  ]);
  const sourceBytes = await readFile(options.inputPath);
  const sourceSha256 = sha256(sourceBytes);
  const overpass = JSON.parse(sourceBytes.toString('utf8'));
  if (!Array.isArray(overpass.elements)) {
    throw new Error('Overpass input has no elements array.');
  }

  const nodeElements = new Map();
  for (const element of overpass.elements) {
    if (
      element.type === 'node' &&
      Number.isFinite(element.lon) &&
      Number.isFinite(element.lat)
    ) {
      nodeElements.set(
        numericOsmId(element.id, 'node'),
        element,
      );
    }
  }

  const strings = [];
  const stringIds = new Map();
  const intern = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return -1;
    const normalized = value.trim();
    const existing = stringIds.get(normalized);
    if (existing !== undefined) return existing;
    const id = strings.length;
    strings.push(normalized);
    stringIds.set(normalized, id);
    return id;
  };

  const nodes = [];
  const nodeIndex = new Map();
  const addNode = (osmNodeId) => {
    const existing = nodeIndex.get(osmNodeId);
    if (existing !== undefined) return existing;
    const element = nodeElements.get(osmNodeId);
    if (!element) return undefined;
    const id = nodes.length;
    nodes.push([
      Math.round(element.lon * COORDINATE_SCALE),
      Math.round(element.lat * COORDINATE_SCALE),
      osmNodeId,
    ]);
    nodeIndex.set(osmNodeId, id);
    return id;
  };

  const stats = {
    missingWayNodes: 0,
    skippedWays: 0,
    unparsedPhysicalRestrictions: 0,
    unsupportedTurnRestrictions: 0,
  };
  const edges = [];
  const includedWays = new Set();
  let segmentId = 0;

  for (const way of overpass.elements) {
    if (way.type !== 'way' || !isRoutableWay(way.tags)) {
      if (way.type === 'way') stats.skippedWays += 1;
      continue;
    }
    if (!Array.isArray(way.nodes) || way.nodes.length < 2) {
      stats.skippedWays += 1;
      continue;
    }
    const tags = way.tags;
    const roadClass =
      tags.highway === 'busway'
        ? ROAD_CLASS.road
        : ROAD_CLASS[tags.highway];
    if (roadClass === undefined) {
      stats.skippedWays += 1;
      continue;
    }
    const oneWay = oneWayDirection(tags);
    const flags = edgeFlags(tags, oneWay);
    const accessBits = packAccess(tags);
    const maxHeightM = parseMetricLength(
      tags['maxheight:physical'] ?? tags.maxheight,
    );
    const maxWidthM = parseMetricLength(tags.maxwidth);
    const maxLengthM = parseMetricLength(tags.maxlength);
    const maxWeightKg = parseMetricWeight(
      tags['maxweight:hgv'] ?? tags.maxweight,
    );
    for (const key of [
      'maxheight:physical',
      'maxheight',
      'maxwidth',
      'maxlength',
      'maxweight:hgv',
      'maxweight',
    ]) {
      if (
        tags[key] !== undefined &&
        ((key.startsWith('maxheight') && maxHeightM === 0) ||
          (key === 'maxwidth' && maxWidthM === 0) ||
          (key === 'maxlength' && maxLengthM === 0) ||
          (key.startsWith('maxweight') && maxWeightKg === 0))
      ) {
        stats.unparsedPhysicalRestrictions += 1;
      }
    }

    const wayId = numericOsmId(way.id, 'way');
    const nameId = intern(tags.name);
    const refId = intern(tags.ref);
    const surfaceId = intern(tags.surface);
    let wayHasEdges = false;

    for (let index = 1; index < way.nodes.length; index += 1) {
      const fromOsmId = way.nodes[index - 1];
      const toOsmId = way.nodes[index];
      const fromElement = nodeElements.get(fromOsmId);
      const toElement = nodeElements.get(toOsmId);
      if (!fromElement || !toElement) {
        stats.missingWayNodes += 1;
        continue;
      }
      const lengthM = haversineDistanceM(
        [fromElement.lon, fromElement.lat],
        [toElement.lon, toElement.lat],
      );
      if (!Number.isFinite(lengthM) || lengthM < 0.1) continue;
      const from = addNode(fromOsmId);
      const to = addNode(toOsmId);
      if (from === undefined || to === undefined || from === to) continue;
      const lengthDecimetres = Math.max(1, Math.round(lengthM * LENGTH_SCALE));
      const physicalSegmentId = segmentId;
      segmentId += 1;
      const common = [
        wayId,
        physicalSegmentId,
        lengthDecimetres,
        roadClass,
        flags,
      ];
      const restrictions = [
        nameId,
        refId,
        surfaceId,
        accessBits,
        Math.max(0, Math.round(maxHeightM * 100)),
        Math.max(0, Math.round(maxWidthM * 100)),
        Math.max(0, Math.round(maxLengthM * 100)),
        Math.max(0, Math.round(maxWeightKg)),
      ];

      if (oneWay !== 'reverse') {
        edges.push([
          from,
          to,
          ...common,
          parseMaxSpeed(tags['maxspeed:forward'] ?? tags.maxspeed),
          ...restrictions,
        ]);
      }
      if (oneWay !== 'forward') {
        edges.push([
          to,
          from,
          ...common,
          parseMaxSpeed(tags['maxspeed:backward'] ?? tags.maxspeed),
          ...restrictions,
        ]);
      }
      wayHasEdges = true;
    }
    if (wayHasEdges) includedWays.add(wayId);
  }

  const turnRestrictions = normalizeRestriction(
    overpass.elements,
    nodeIndex,
    includedWays,
    stats,
  );
  const speedCameras = overpass.elements
    .filter(
      (element) =>
        element.type === 'node' &&
        element.tags?.highway === 'speed_camera' &&
        Number.isFinite(element.lon) &&
        Number.isFinite(element.lat),
    )
    .map((element) => [
      Math.round(element.lon * COORDINATE_SCALE),
      Math.round(element.lat * COORDINATE_SCALE),
      parseMaxSpeed(element.tags.maxspeed),
      intern(element.tags.name),
      numericOsmId(element.id, 'speed camera'),
    ]);

  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const node of nodes) {
    const longitude = node[0] / COORDINATE_SCALE;
    const latitude = node[1] / COORDINATE_SCALE;
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }

  const graph = {
    format: 'veyra-routing-graph',
    formatVersion: 1,
    metadata: {
      id: options.id,
      revision: options.revision,
      generatedAt: new Date().toISOString(),
      ...(overpass.osm3s?.timestamp_osm_base
        ? { dataTimestamp: overpass.osm3s.timestamp_osm_base }
        : {}),
      sourceName: basename(options.inputPath),
      sourceSha256,
      bounds: [west, south, east, north],
      coordinateScale: COORDINATE_SCALE,
      lengthScale: LENGTH_SCALE,
      counts: {
        nodes: nodes.length,
        directedEdges: edges.length,
        physicalSegments: segmentId,
        turnRestrictions: turnRestrictions.length,
        unsupportedTurnRestrictions: stats.unsupportedTurnRestrictions,
        speedCameras: speedCameras.length,
      },
      buildWarnings: stats,
    },
    strings,
    nodes,
    edges,
    turnRestrictions,
    speedCameras,
  };
  validateBuiltGraph(graph);

  const graphJson = `${JSON.stringify(graph)}\n`;
  const graphBytes = Buffer.from(graphJson);
  const compressed = gzipSync(graphBytes, { level: 9 });
  const graphSha256 = sha256(graphBytes);
  const gzipSha256 = sha256(compressed);
  const manifest = {
    manifestVersion: 1,
    generatedAt: new Date().toISOString(),
    graph: {
      id: options.id,
      revision: options.revision,
      format: 'veyra-routing-graph',
      formatVersion: 1,
      schema: 'compact-json-tuples-v1',
      plain: {
        fileName: basename(options.outputPath),
        bytes: graphBytes.byteLength,
        sha256: graphSha256,
      },
      gzip: {
        fileName: basename(options.gzipPath),
        bytes: compressed.byteLength,
        sha256: gzipSha256,
        contentSha256: graphSha256,
      },
      source: {
        fileName: basename(options.inputPath),
        bytes: sourceBytes.byteLength,
        sha256: sourceSha256,
        dataTimestamp: overpass.osm3s?.timestamp_osm_base,
        license: 'ODbL-1.0',
        attribution: '© OpenStreetMap contributors',
      },
      bounds: graph.metadata.bounds,
      counts: graph.metadata.counts,
      buildWarnings: stats,
    },
  };

  await atomicWrite(options.outputPath, graphBytes);
  await atomicWrite(options.gzipPath, compressed);
  await atomicWrite(
    options.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  process.stdout.write(
    `Graph ${options.outputPath}\n` +
      `  ${nodes.length} nodes\n` +
      `  ${edges.length} directed edges\n` +
      `  ${turnRestrictions.length} enforced turn restrictions\n` +
      `  ${stats.unsupportedTurnRestrictions} unsupported turn restrictions\n` +
      `  ${speedCameras.length} speed cameras preserved\n` +
      `  JSON ${(graphBytes.byteLength / 1_048_576).toFixed(1)} MiB\n` +
      `  gzip ${(compressed.byteLength / 1_048_576).toFixed(1)} MiB\n` +
      `Manifest ${options.manifestPath}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 1;
});
