#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_INPUT = resolve(
  PROJECT_ROOT,
  'data/osm/torino-routing-20260725.json',
);
const DEFAULT_OUTPUT = resolve(
  PROJECT_ROOT,
  'assets/search/torino-v2.vsearch',
);

const FORMAT = 'veyra.offline-search';
const FORMAT_VERSION = 2;
const BUILD_TOOL_VERSION = '2.1.0';
const CLUSTER_DISTANCE_METERS = 120;
const DEFAULT_REGION_ID = 'it-piemonte-torino';
const DEFAULT_REGION_NAME = 'Torino e prima cintura';

const SEARCHABLE_HIGHWAYS = new Set([
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
  'pedestrian',
  'track',
]);

const HIGHWAY_IMPORTANCE = {
  motorway: 100,
  motorway_link: 96,
  trunk: 94,
  trunk_link: 90,
  primary: 88,
  primary_link: 84,
  secondary: 78,
  secondary_link: 74,
  tertiary: 68,
  tertiary_link: 64,
  unclassified: 58,
  residential: 52,
  living_street: 48,
  pedestrian: 46,
  road: 42,
  service: 32,
  track: 24,
};

const PUBLIC_SPACE_PREFIXES = [
  'area ',
  'largo ',
  'piazza ',
  'piazzale ',
  'piazzetta ',
  'rotonda ',
  'slargo ',
];

function usage() {
  console.log(`Build the deterministic Veyra offline-search asset.

Usage:
  node scripts/build-offline-search-index.mjs [options]

Options:
  --input <path>   Overpass JSON source
  --output <path>  Destination .vsearch asset
  --region-id <id> Stable pack/region identifier
  --region-name <name> Human-readable region name
  --help           Show this help
`);
}

function parseArgs(argv) {
  const result = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    regionId: DEFAULT_REGION_ID,
    regionName: DEFAULT_REGION_NAME,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      usage();
      process.exit(0);
    }
    if (
      argument !== '--input' &&
      argument !== '--output' &&
      argument !== '--region-id' &&
      argument !== '--region-name'
    ) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a path`);
    }
    if (argument === '--input' || argument === '--output') {
      result[argument.slice(2)] = resolve(process.cwd(), value);
    } else {
      result[
        argument === '--region-id' ? 'regionId' : 'regionName'
      ] = value.trim();
    }
    index += 1;
  }

  return result;
}

function normalizeForSearch(value) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[’'`´]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function splitTaggedNames(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
}

function namesFromTags(tags) {
  const values = [];
  const keys = [
    'name',
    'official_name',
    'short_name',
    'alt_name',
    'loc_name',
    'old_name',
  ];

  for (const key of keys) {
    values.push(...splitTaggedNames(tags[key]));
  }
  for (const [key, value] of Object.entries(tags)) {
    if (/^name:[a-z]{2,3}(?:[-_][A-Za-z0-9]+)?$/.test(key)) {
      values.push(...splitTaggedNames(value));
    }
  }

  return [...new Set(values)];
}

function displayNameFromTags(tags) {
  const name =
    splitTaggedNames(tags.name)[0] ??
    splitTaggedNames(tags.official_name)[0] ??
    splitTaggedNames(tags.short_name)[0];
  if (name) {
    return { displayName: name, referenceOnly: false };
  }
  const reference = splitTaggedNames(tags.ref)[0];
  return reference
    ? { displayName: reference, referenceOnly: true }
    : undefined;
}

function validCoordinate(longitude, latitude) {
  return Number.isFinite(longitude) && Number.isFinite(latitude) &&
    Math.abs(longitude) <= 180 && Math.abs(latitude) <= 85.051129;
}

function featureCoordinate(element, nodes) {
  if (element.type === 'node') {
    return validCoordinate(element.lon, element.lat)
      ? [element.lon, element.lat] : undefined;
  }
  if (validCoordinate(element.center?.lon, element.center?.lat)) {
    return [element.center.lon, element.center.lat];
  }
  const coordinates = (element.nodes ?? []).map((id) => nodes.get(id));
  // A partial building outline must not silently move a destination elsewhere.
  if (!coordinates.length || coordinates.some((point) => !point)) return undefined;
  return representativeCoordinate([{ coordinates }]);
}

const POI_TAGS = ['shop', 'amenity', 'tourism', 'leisure', 'office', 'historic', 'place'];
const CATEGORY_ALIASES = {
  supermarket: ['supermercato', 'supermarché', 'supermercado', 'Supermarkt'],
  pharmacy: ['farmacia', 'pharmacie', 'Apotheke'],
  hospital: ['ospedale', 'hôpital', 'Krankenhaus'],
  museum: ['museo', 'musée', 'Museum'],
  fuel: ['distributore', 'benzina', 'diesel', 'petrol station', 'gas station', 'Tankstelle'],
  parking: ['parcheggio', 'Parkplatz', 'aparcamiento'],
  restaurant: ['ristorante', 'restaurante'],
  charging_station: ['ricarica', 'charging station', 'Ladestation'],
};

function squaredDistance(left, right) {
  const latitudeScale = 111_320;
  const meanLatitude = ((left[1] + right[1]) / 2) * (Math.PI / 180);
  const longitudeScale = Math.cos(meanLatitude) * latitudeScale;
  const dx = (left[0] - right[0]) * longitudeScale;
  const dy = (left[1] - right[1]) * latitudeScale;
  return dx * dx + dy * dy;
}

function distanceMeters(left, right) {
  return Math.sqrt(squaredDistance(left, right));
}

function distanceBetweenBounds(left, right) {
  const longitudeGap =
    left[2] < right[0]
      ? right[0] - left[2]
      : right[2] < left[0]
        ? left[0] - right[2]
        : 0;
  const latitudeGap =
    left[3] < right[1]
      ? right[1] - left[3]
      : right[3] < left[1]
        ? left[1] - right[3]
        : 0;
  if (longitudeGap === 0 && latitudeGap === 0) return 0;

  const meanLatitude =
    ((left[1] + left[3] + right[1] + right[3]) / 4) *
    (Math.PI / 180);
  return Math.hypot(
    longitudeGap * Math.cos(meanLatitude) * 111_320,
    latitudeGap * 111_320,
  );
}

function boundsForCoordinates(coordinates) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [longitude, latitude] of coordinates) {
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }
  return [west, south, east, north];
}

class DisjointSet {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index);
    this.rank = new Uint8Array(size);
  }

  find(index) {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[index] !== index) {
      const next = this.parent[index];
      this.parent[index] = root;
      index = next;
    }
    return root;
  }

  union(left, right) {
    let leftRoot = this.find(left);
    let rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (this.rank[leftRoot] < this.rank[rightRoot]) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    this.parent[rightRoot] = leftRoot;
    if (this.rank[leftRoot] === this.rank[rightRoot]) {
      this.rank[leftRoot] += 1;
    }
  }
}

function componentsForNamedWays(ways) {
  const disjointSet = new DisjointSet(ways.length);
  const nodeOwners = new Map();

  ways.forEach((way, wayIndex) => {
    for (const nodeId of way.nodeIds) {
      const existingOwner = nodeOwners.get(nodeId);
      if (existingOwner === undefined) {
        nodeOwners.set(nodeId, wayIndex);
      } else {
        disjointSet.union(wayIndex, existingOwner);
      }
    }
  });

  const exactComponents = new Map();
  ways.forEach((way, wayIndex) => {
    const root = disjointSet.find(wayIndex);
    const component = exactComponents.get(root) ?? {
      indices: [],
      coordinates: [],
    };
    component.indices.push(wayIndex);
    component.coordinates.push(...way.coordinates);
    exactComponents.set(root, component);
  });

  const components = [...exactComponents.values()].map((component) => ({
    ...component,
    bounds: boundsForCoordinates(component.coordinates),
  }));

  const nearbySet = new DisjointSet(components.length);
  for (let left = 0; left < components.length; left += 1) {
    for (let right = left + 1; right < components.length; right += 1) {
      if (
        distanceBetweenBounds(
          components[left].bounds,
          components[right].bounds,
        ) <= CLUSTER_DISTANCE_METERS
      ) {
        nearbySet.union(left, right);
      }
    }
  }

  const merged = new Map();
  components.forEach((component, index) => {
    const root = nearbySet.find(index);
    const indices = merged.get(root) ?? [];
    indices.push(...component.indices);
    merged.set(root, indices);
  });
  return [...merged.values()].map((indices) =>
    indices.map((index) => ways[index]),
  );
}

function representativeCoordinate(ways) {
  let weightedLongitude = 0;
  let weightedLatitude = 0;
  let totalWeight = 0;
  const candidates = [];

  for (const way of ways) {
    candidates.push(...way.coordinates);
    for (let index = 1; index < way.coordinates.length; index += 1) {
      const start = way.coordinates[index - 1];
      const end = way.coordinates[index];
      const weight = distanceMeters(start, end);
      if (weight <= 0) continue;
      weightedLongitude += ((start[0] + end[0]) / 2) * weight;
      weightedLatitude += ((start[1] + end[1]) / 2) * weight;
      totalWeight += weight;
    }
  }

  const target =
    totalWeight > 0
      ? [
          weightedLongitude / totalWeight,
          weightedLatitude / totalWeight,
        ]
      : candidates[0];
  let nearest = candidates[0];
  let nearestDistance = Infinity;
  for (const coordinate of candidates) {
    const candidateDistance = squaredDistance(coordinate, target);
    if (candidateDistance < nearestDistance) {
      nearest = coordinate;
      nearestDistance = candidateDistance;
    }
  }
  return nearest;
}

function wayLengthMeters(way) {
  let length = 0;
  for (let index = 1; index < way.coordinates.length; index += 1) {
    length += distanceMeters(
      way.coordinates[index - 1],
      way.coordinates[index],
    );
  }
  return length;
}

function classifyEntry(displayName, ways, referenceOnly) {
  if (referenceOnly) return 'r';
  const normalized = `${normalizeForSearch(displayName)} `;
  if (PUBLIC_SPACE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return 'p';
  }
  if (ways.every((way) => way.highway === 'pedestrian')) return 'p';
  return 's';
}

function importanceForWays(ways) {
  const highwayScore = Math.max(
    ...ways.map((way) => HIGHWAY_IMPORTANCE[way.highway] ?? 0),
  );
  const totalLength = ways.reduce(
    (sum, way) => sum + wayLengthMeters(way),
    0,
  );
  return Math.min(
    127,
    Math.round(
      highwayScore +
        Math.min(14, Math.log10(totalLength + 1) * 3) +
        Math.min(8, Math.log2(ways.length + 1) * 1.5),
    ),
  );
}

export function buildIndex(
  source,
  inputPath,
  region = { id: DEFAULT_REGION_ID, name: DEFAULT_REGION_NAME },
) {
  if (
    !source ||
    !Array.isArray(source.elements) ||
    !source.osm3s ||
    typeof source.osm3s.timestamp_osm_base !== 'string' ||
    !Number.isFinite(Date.parse(source.osm3s.timestamp_osm_base))
  ) {
    throw new Error('Input is not the expected Overpass JSON document.');
  }
  if (
    !region ||
    typeof region.id !== 'string' ||
    !region.id.trim() ||
    typeof region.name !== 'string' ||
    !region.name.trim()
  ) {
    throw new Error('Region id and name are required.');
  }

  const nodes = new Map();
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const element of source.elements) {
    if (
      element.type !== 'node' ||
      !validCoordinate(element.lon, element.lat)
    ) {
      continue;
    }
    nodes.set(element.id, [element.lon, element.lat]);
    west = Math.min(west, element.lon);
    south = Math.min(south, element.lat);
    east = Math.max(east, element.lon);
    north = Math.max(north, element.lat);
  }

  const groups = new Map();
  let skippedGeometry = 0;
  for (const element of source.elements) {
    if (
      element.type !== 'way' ||
      !element.tags ||
      !SEARCHABLE_HIGHWAYS.has(element.tags.highway)
    ) {
      continue;
    }
    const named = displayNameFromTags(element.tags);
    if (!named) continue;

    const coordinates = (element.nodes ?? []).map((nodeId) => nodes.get(nodeId));
    if (coordinates.length < 2 || coordinates.some((point) => !point)) {
      skippedGeometry += 1;
      continue;
    }

    const normalizedName = normalizeForSearch(named.displayName);
    if (!normalizedName) continue;
    const aliases = new Set(namesFromTags(element.tags));
    if (element.tags.ref) {
      for (const reference of splitTaggedNames(element.tags.ref)) {
        aliases.add(reference);
      }
    }
    aliases.delete(named.displayName);

    const group = groups.get(normalizedName) ?? [];
    group.push({
      id: element.id,
      nodeIds: element.nodes,
      coordinates,
      displayName: named.displayName,
      referenceOnly: named.referenceOnly,
      aliases: [...aliases],
      highway: element.tags.highway,
    });
    groups.set(normalizedName, group);
  }

  const entries = [];
  const normalizedNames = [...groups.keys()].sort();
  for (const normalizedName of normalizedNames) {
    const namedWays = groups.get(normalizedName);
    for (const componentWays of componentsForNamedWays(namedWays)) {
      const displayName = [...componentWays]
        .sort((left, right) =>
          left.displayName < right.displayName
            ? -1
            : left.displayName > right.displayName
              ? 1
              : left.id - right.id,
        )[0].displayName;
      const representative = representativeCoordinate(componentWays);
      const aliases = [
        ...new Set(componentWays.flatMap((way) => way.aliases)),
      ]
        .filter(
          (alias) =>
            normalizeForSearch(alias) !== normalizeForSearch(displayName),
        )
        .sort();
      const representativeWay = [...componentWays].sort(
        (left, right) => left.id - right.id,
      )[0];
      const referenceOnly = componentWays.every((way) => way.referenceOnly);

      entries.push([
        displayName,
        aliases,
        Math.round(representative[0] * 1_000_000),
        Math.round(representative[1] * 1_000_000),
        classifyEntry(displayName, componentWays, referenceOnly),
        importanceForWays(componentWays),
        representativeWay.id,
        componentWays.length,
        'w',
        '',
        '',
      ]);
    }
  }

  let addressEntries = 0;
  let skippedAddressGeometry = 0;
  for (const element of source.elements) {
    const tags = element.tags;
    if (
      (element.type !== 'node' && element.type !== 'way') ||
      !tags ||
      !Number.isSafeInteger(element.id) ||
      element.id <= 0
    ) {
      continue;
    }
    const street =
      typeof tags['addr:street'] === 'string'
        ? tags['addr:street'].trim()
        : typeof tags['addr:place'] === 'string'
          ? tags['addr:place'].trim()
          : '';
    const houseNumbers = splitTaggedNames(tags['addr:housenumber']);
    if (!street || houseNumbers.length === 0) continue;

    const representative = featureCoordinate(element, nodes);
    if (!representative) {
      skippedAddressGeometry += 1;
      continue;
    }

    west = Math.min(west, representative[0]);
    south = Math.min(south, representative[1]);
    east = Math.max(east, representative[0]);
    north = Math.max(north, representative[1]);

    for (const houseNumber of houseNumbers) {
      const displayName = `${street} ${houseNumber}`;
      const aliases = new Set([
        `${houseNumber} ${street}`,
        `${street}, ${houseNumber}`,
      ]);
      const locality =
        typeof tags['addr:city'] === 'string'
          ? tags['addr:city'].trim()
          : typeof tags['addr:town'] === 'string'
            ? tags['addr:town'].trim()
            : typeof tags['addr:village'] === 'string'
              ? tags['addr:village'].trim()
              : '';
      const postcode =
        typeof tags['addr:postcode'] === 'string'
          ? tags['addr:postcode'].trim()
          : '';
      const unit =
        typeof tags['addr:unit'] === 'string'
          ? tags['addr:unit'].trim()
          : '';
      const houseName =
        typeof tags['addr:housename'] === 'string'
          ? tags['addr:housename'].trim()
          : '';
      if (locality) {
        aliases.add(`${displayName}, ${locality}`);
        aliases.add(`${houseNumber} ${street}, ${locality}`);
      }
      if (postcode && locality) {
        aliases.add(`${displayName}, ${postcode} ${locality}`);
      }
      if (unit) aliases.add(`${displayName} ${unit}`);
      if (houseName) aliases.add(houseName);

      entries.push([
        displayName,
        [...aliases]
          .filter(
            (alias) =>
              normalizeForSearch(alias) !== normalizeForSearch(displayName),
          )
          .sort(),
        Math.round(representative[0] * 1_000_000),
        Math.round(representative[1] * 1_000_000),
        'a',
        62,
        element.id,
        1,
        element.type === 'node' ? 'n' : 'w',
        houseNumber,
        street,
      ]);
      addressEntries += 1;
    }
  }

  let poiEntries = 0;
  let skippedPoiGeometry = 0;
  for (const element of source.elements) {
    const tags = element.tags;
    if (!tags || !['node', 'way'].includes(element.type) ||
      !Number.isSafeInteger(element.id) || element.id <= 0) continue;
    const categories = POI_TAGS.map((key) => tags[key]).filter(
      (value) => typeof value === 'string' && value.trim() &&
        !['no', 'vacant', 'construction', 'proposed'].includes(value),
    );
    if (!categories.length || tags.disused === 'yes' || tags.abandoned === 'yes') continue;
    const names = namesFromTags(tags);
    const brands = splitTaggedNames(tags.brand);
    const name = names[0] ?? brands[0];
    // Unnamed categories are not invented business names. Keep only named POIs
    // until the binary search schema has a separate localized category field.
    if (!name) continue;
    const point = featureCoordinate(element, nodes);
    if (!point) { skippedPoiGeometry += 1; continue; }
    const locality = tags['addr:city'] ?? tags['addr:town'] ?? tags['addr:village'];
    const street = tags['addr:street'];
    const address = [street, tags['addr:housenumber']].filter(Boolean).join(' ');
    const aliases = new Set([...names, ...brands,
      ...categories.flatMap((category) => [category.replaceAll('_', ' '), ...(CATEGORY_ALIASES[category] ?? [])]),
    ]);
    if (locality) {
      for (const alias of [...aliases]) aliases.add(`${alias} ${locality}`);
    }
    if (address) aliases.add(`${name} ${address}`);
    aliases.delete(name);
    entries.push([name, [...aliases].sort(), Math.round(point[0] * 1e6),
      Math.round(point[1] * 1e6), 'p', 64, element.id, 1,
      element.type === 'node' ? 'n' : 'w', '', '']);
    west = Math.min(west, point[0]); south = Math.min(south, point[1]);
    east = Math.max(east, point[0]); north = Math.max(north, point[1]);
    poiEntries += 1;
  }

  entries.sort((left, right) => {
    const nameOrder = normalizeForSearch(left[0]).localeCompare(
      normalizeForSearch(right[0]),
      'en',
    );
    if (nameOrder !== 0) return nameOrder;
    if (left[3] !== right[3]) return left[3] - right[3];
    if (left[2] !== right[2]) return left[2] - right[2];
    return left[6] - right[6];
  });

  const sourceTimestamp = source.osm3s.timestamp_osm_base;
  const revision = `osm-${sourceTimestamp.slice(0, 10).replaceAll('-', '')}`;
  return {
    index: {
      format: FORMAT,
      version: FORMAT_VERSION,
      revision,
      region: {
        id: region.id.trim(),
        name: region.name.trim(),
        bounds: [west, south, east, north],
      },
      source: {
        provider: 'OpenStreetMap',
        timestamp: sourceTimestamp,
        attribution: '© OpenStreetMap contributors',
        copyright:
          typeof source.osm3s.copyright === 'string'
            ? source.osm3s.copyright
            : 'OpenStreetMap data is available under ODbL.',
        license: 'ODbL-1.0',
        licenseUrl: 'https://www.openstreetmap.org/copyright',
        input: relative(PROJECT_ROOT, inputPath),
      },
      build: {
        tool: 'scripts/build-offline-search-index.mjs',
        version: BUILD_TOOL_VERSION,
        clusterDistanceMeters: CLUSTER_DISTANCE_METERS,
      },
      entries,
    },
    stats: {
      sourceElements: source.elements.length,
      sourceWays: source.elements.filter(
        (element) => element.type === 'way',
      ).length,
      addressEntries,
      poiEntries,
      skippedPoiGeometry,
      namedGroups: groups.size,
      entries: entries.length,
      skippedGeometry,
      skippedAddressGeometry,
    },
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceText = readFileSync(options.input, 'utf8');
  const source = JSON.parse(sourceText);
  const { index, stats } = buildIndex(source, options.input, {
    id: options.regionId,
    name: options.regionName,
  });
  const outputText = `${JSON.stringify(index)}\n`;

  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, outputText);
  const sha256 = createHash('sha256').update(outputText).digest('hex');
  const manifestPath = `${options.output}.manifest.json`;
  const manifest = {
    format: FORMAT,
    version: FORMAT_VERSION,
    revision: index.revision,
    file: relative(dirname(manifestPath), options.output),
    bytes: Buffer.byteLength(outputText),
    sha256,
    entries: stats.entries,
    sourceTimestamp: index.source.timestamp,
    sourceAttribution: index.source.attribution,
    sourceLicense: index.source.license,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const sourceBytes = statSync(options.input).size;
  const outputBytes = Buffer.byteLength(outputText);
  console.log(
    JSON.stringify(
      {
        input: relative(PROJECT_ROOT, options.input),
        output: relative(PROJECT_ROOT, options.output),
        manifest: relative(PROJECT_ROOT, manifestPath),
        sourceBytes,
        outputBytes,
        compressionRatio: Number((outputBytes / sourceBytes).toFixed(4)),
        sha256,
        ...stats,
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error
        ? `Search index build failed: ${error.message}`
        : error,
    );
    process.exitCode = 1;
  }
}
