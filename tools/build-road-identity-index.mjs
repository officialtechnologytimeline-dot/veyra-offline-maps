#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAGIC = 'VYRIDX01';
const PREFIX_BYTES = 44;
const TILE_MAGIC = 'RIT1';
const TILE_HEADER_BYTES = 8;
const RECORD_BYTES = 44;
const NODE_PAIR_MAGIC = 'RIP1';
const NODE_PAIR_HEADER_BYTES = 8;
const NODE_PAIR_RECORD_BYTES = 48;
const DEFAULT_ZOOM = 15;
const MIN_NODE_PAIR_SHARD_BITS = 6;
const MAX_NODE_PAIR_SHARD_BITS = 20;
const DEFAULT_MAX_CHUNK_BYTES = 2 * 1_048_576;
const DEFAULT_MAX_TILE_RECORDS = 45_000;
const MAX_EDGE_TILES = 64;
const MAX_SPATIAL_TILES = 45_000;
const MAX_NODE_PAIR_SHARDS = 4_096;
const MAX_DIRECTORY_BYTES = 8 * 1_048_576;
const ACCESS_SHIFT = {
  access: 0,
  vehicle: 4,
  motorVehicle: 8,
  motorcar: 12,
  hgv: 16,
};
const BLOCKED_ACCESS = new Set([7, 8, 9, 10, 11]);

export async function buildRoadIdentityIndex(options) {
  const graphBytes = await fs.readFile(options.graph);
  const graph = JSON.parse(graphBytes.toString('utf8'));
  validateGraph(graph);
  const zoom = integerOption(options.zoom, DEFAULT_ZOOM, 8, 20);
  const maxTileRecords = integerOption(
    options.maxTileRecords,
    DEFAULT_MAX_TILE_RECORDS,
    1,
    180_000,
  );
  const requestedNodePairShardBits =
    options.nodePairShardBits === undefined
      ? undefined
      : integerOption(
          options.nodePairShardBits,
          MIN_NODE_PAIR_SHARD_BITS,
          MIN_NODE_PAIR_SHARD_BITS,
          MAX_NODE_PAIR_SHARD_BITS,
        );
  const maxChunkBytes = integerOption(
    options.maxChunkBytes,
    DEFAULT_MAX_CHUNK_BYTES,
    64 * 1024,
    8 * 1_048_576,
  );
  const graphLineage = requiredIdentifier(
    options.graphLineage ?? graph.metadata.id,
    'graph-lineage',
  );
  const routingGraphId = requiredIdentifier(
    graph.metadata.id,
    'graph.metadata.id',
  );
  if (graphLineage !== routingGraphId) {
    throw new Error(
      '--graph-lineage must equal graph.metadata.id so routing and road identity share one lineage.',
    );
  }
  const graphRevision =
    options.graphRevision ?? graph.metadata.revision;
  requiredRevision(graphRevision, 'graph-revision');
  if (graphRevision !== graph.metadata.revision) {
    throw new Error(
      '--graph-revision must equal graph.metadata.revision.',
    );
  }
  const generatedAt = normalizedIsoDate(
    options.generatedAt ?? graph.metadata.generatedAt,
    'generated-at',
  );
  const dataTimestamp =
    graph.metadata.dataTimestamp === undefined
      ? undefined
      : normalizedIsoDate(
          graph.metadata.dataTimestamp,
          'graph.metadata.dataTimestamp',
        );
  const sourceSha256 =
    options.sourceSha256 ??
    graph.metadata.sourceSha256 ??
    sha256(graphBytes);
  requiredSha256(sourceSha256, 'source-sha256');
  const provenance = {
    publisherId: requiredIdentifier(
      options.publisherId,
      'publisher-id',
    ),
    datasetId: requiredIdentifier(options.datasetId, 'dataset-id'),
    sourceArchiveUrl: requiredHttps(
      options.sourceArchiveUrl,
      'source-archive-url',
    ),
    sourceSha256: sourceSha256.toLowerCase(),
    license: requiredText(options.license, 'license', 80),
    rightsNoticeUrl: requiredHttps(
      options.rightsNoticeUrl,
      'rights-notice-url',
    ),
    buildPipelineId: requiredIdentifier(
      options.buildPipelineId,
      'build-pipeline-id',
    ),
    buildPipelineVersion: requiredText(
      options.buildPipelineVersion,
      'build-pipeline-version',
      96,
    ),
  };

  const segments = physicalSegments(graph);
  const byTile = new Map();
  let tileReferences = 0;
  for (const segment of segments) {
    const tileIds = segmentTileIds(segment, zoom);
    if (tileIds.length === 0 || tileIds.length > MAX_EDGE_TILES) {
      throw new Error(
        `Physical segment ${segment.segmentId} spans an unsafe tile count.`,
      );
    }
    for (const tileId of tileIds) {
      const records = byTile.get(tileId) ?? [];
      records.push(segment);
      byTile.set(tileId, records);
      tileReferences += 1;
    }
  }
  if (byTile.size > MAX_SPATIAL_TILES) {
    throw new Error(
      `Road-identity directory would contain ${byTile.size} spatial tiles; lower --zoom or split the publication before exceeding ${MAX_SPATIAL_TILES}.`,
    );
  }

  const payloadChunks = [];
  const tiles = [];
  let payloadOffset = 0;
  const sortedTiles = [...byTile.entries()].sort(([left], [right]) =>
    left.localeCompare(right, 'en', { numeric: true }),
  );
  for (const [id, records] of sortedTiles) {
    if (records.length > maxTileRecords) {
      throw new Error(
        `Tile ${id} has ${records.length} records; increase zoom instead of the mobile memory budget.`,
      );
    }
    records.sort(compareSegment);
    const tileBytes = encodeTile(records);
    const [, x, y] = id.split('/').map(Number);
    tiles.push({
      id,
      x,
      y,
      offset: payloadOffset,
      bytes: tileBytes.byteLength,
      records: records.length,
      sha256: sha256(tileBytes),
    });
    payloadChunks.push(tileBytes);
    payloadOffset += tileBytes.byteLength;
  }

  const uniqueNodePairs = uniqueNodePairRecords(segments);
  const nodePairRecordLimit = Math.min(
    maxTileRecords,
    Math.floor(
      (maxChunkBytes - NODE_PAIR_HEADER_BYTES) /
        NODE_PAIR_RECORD_BYTES,
    ),
  );
  const {
    shardBits: nodePairShardBits,
    byShard: byNodePairShard,
  } = selectNodePairShards(
    uniqueNodePairs,
    requestedNodePairShardBits,
    nodePairRecordLimit,
  );
  const nodePairShards = [];
  for (
    const [shard, records] of
    [...byNodePairShard.entries()].sort(
      ([left], [right]) => left - right,
    )
  ) {
    records.sort(compareNodePair);
    if (records.length > maxTileRecords) {
      throw new Error(
        `Node-pair shard ${shard} has ${records.length} records; increase --node-pair-shard-bits or --max-chunk-bytes.`,
      );
    }
    const shardBytes = encodeNodePairShard(records);
    nodePairShards.push({
      id: shard
        .toString(16)
        .padStart(Math.ceil(nodePairShardBits / 4), '0'),
      shard,
      offset: payloadOffset,
      bytes: shardBytes.byteLength,
      records: records.length,
      sha256: sha256(shardBytes),
    });
    payloadChunks.push(shardBytes);
    payloadOffset += shardBytes.byteLength;
  }
  if (nodePairShards.length > MAX_NODE_PAIR_SHARDS) {
    throw new Error(
      `Road-identity directory would contain more than ${MAX_NODE_PAIR_SHARDS} node-pair shards.`,
    );
  }

  const manifest = {
    format: 'veyra-road-identity-index',
    formatVersion: 1,
    byteOrder: 'LE',
    graphLineage,
    graphRevision,
    generatedAt,
    ...(dataTimestamp ? { dataTimestamp } : {}),
    bounds: graph.metadata.bounds,
    coverage: 'all-routable-physical-segments',
    tileScheme: { type: 'web-mercator', zoom },
    recordEncoding: {
      type: 'fixed-v1',
      bytes: RECORD_BYTES,
      coordinateScale: 10_000_000,
      osmIdEncoding: 'uint64-le',
    },
    physicalSegments: segments.length,
    tileReferences,
    payloadBytes: payloadOffset,
    provenance,
    tiles,
    nodePairIndex: {
      type: 'fnv1a32-prefix',
      shardBits: nodePairShardBits,
      recordEncoding: {
        type: 'fixed-v1',
        bytes: NODE_PAIR_RECORD_BYTES,
        osmIdEncoding: 'uint64-le',
        lengthScale: 10,
        coordinateScale: 10_000_000,
      },
      records: uniqueNodePairs.length,
      shards: nodePairShards,
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (manifestBytes.byteLength > MAX_DIRECTORY_BYTES) {
    throw new Error('Road-identity directory exceeds the format limit.');
  }
  const directorySha256 = sha256(manifestBytes);
  const prefix = Buffer.alloc(PREFIX_BYTES);
  prefix.write(MAGIC, 0, 'ascii');
  prefix.writeUInt32LE(manifestBytes.byteLength, 8);
  Buffer.from(directorySha256, 'hex').copy(prefix, 12);
  const output = Buffer.concat([
    prefix,
    manifestBytes,
    ...payloadChunks,
  ]);
  const outputPath = path.resolve(options.output);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, output);
  if (options.manifestOutput) {
    const manifestOutputPath = path.resolve(options.manifestOutput);
    await fs.mkdir(path.dirname(manifestOutputPath), {
      recursive: true,
    });
    await fs.writeFile(
      manifestOutputPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
  }
  return Object.freeze({
    output: outputPath,
    bytes: output.byteLength,
    sha256: sha256(output),
    directorySha256,
    graphLineage,
    graphRevision,
    physicalSegments: segments.length,
    tileReferences,
    tiles: tiles.length,
    maximumTileRecords: Math.max(
      ...tiles.map((tile) => tile.records),
    ),
    nodePairRecords: uniqueNodePairs.length,
    nodePairShards: nodePairShards.length,
    manifest,
  });
}

function physicalSegments(graph) {
  const bySegment = new Map();
  for (let edgeId = 0; edgeId < graph.edges.length; edgeId += 1) {
    const edge = graph.edges[edgeId];
    if (!Array.isArray(edge) || edge.length !== 16) {
      throw new Error(`Routing edge ${edgeId} is invalid.`);
    }
    const from = safeIndex(edge[0], graph.nodes.length, `edge ${edgeId} from`);
    const to = safeIndex(edge[1], graph.nodes.length, `edge ${edgeId} to`);
    const wayId = positiveSafeInteger(edge[2], `edge ${edgeId} way`);
    const segmentId = nonNegativeSafeInteger(
      edge[3],
      `edge ${edgeId} segment`,
    );
    const fromNode = graph.nodes[from];
    const toNode = graph.nodes[to];
    const firstNodeId = positiveSafeInteger(
      fromNode?.[2],
      `edge ${edgeId} from OSM node`,
    );
    const secondNodeId = positiveSafeInteger(
      toNode?.[2],
      `edge ${edgeId} to OSM node`,
    );
    if (firstNodeId === secondNodeId) {
      throw new Error(`Routing edge ${edgeId} has identical OSM nodes.`);
    }
    const canonicalForward = firstNodeId < secondNodeId;
    const nodeA = canonicalForward ? fromNode : toNode;
    const nodeB = canonicalForward ? toNode : fromNode;
    const nodeAId = canonicalForward ? firstNodeId : secondNodeId;
    const nodeBId = canonicalForward ? secondNodeId : firstNodeId;
    const candidate = {
      segmentId,
      osmWayId: wayId,
      nodeAId,
      nodeBId,
      longitudeAE7: coordinateE7(nodeA?.[0], true, edgeId),
      latitudeAE7: coordinateE7(nodeA?.[1], false, edgeId),
      longitudeBE7: coordinateE7(nodeB?.[0], true, edgeId),
      latitudeBE7: coordinateE7(nodeB?.[1], false, edgeId),
      accessMask: accessMask(edge[11]),
      edgeLengthDecimetres: positiveSafeInteger(
        edge[4],
        `edge ${edgeId} length`,
      ),
    };
    const previous = bySegment.get(segmentId);
    if (!previous) {
      bySegment.set(segmentId, candidate);
      continue;
    }
    if (
      previous.osmWayId !== candidate.osmWayId ||
      previous.nodeAId !== candidate.nodeAId ||
      previous.nodeBId !== candidate.nodeBId ||
      previous.longitudeAE7 !== candidate.longitudeAE7 ||
      previous.latitudeAE7 !== candidate.latitudeAE7 ||
      previous.longitudeBE7 !== candidate.longitudeBE7 ||
      previous.latitudeBE7 !== candidate.latitudeBE7
    ) {
      throw new Error(
        `Physical segment ${segmentId} has inconsistent directed edges.`,
      );
    }
    if (
      previous.edgeLengthDecimetres !==
      candidate.edgeLengthDecimetres
    ) {
      throw new Error(
        `Physical segment ${segmentId} has inconsistent length.`,
      );
    }
    previous.accessMask |= candidate.accessMask;
  }
  const segments = [...bySegment.values()];
  if (
    segments.length !== graph.metadata.counts.physicalSegments ||
    segments.length === 0
  ) {
    throw new Error(
      'Routing physical-segment count does not match metadata.',
    );
  }
  return segments;
}

function accessMask(bitsValue) {
  const bits = nonNegativeSafeInteger(bitsValue, 'edge access bits');
  const effective = (accessClass) => {
    const shifts =
      accessClass === 'hgv'
        ? [
            ACCESS_SHIFT.hgv,
            ACCESS_SHIFT.motorVehicle,
            ACCESS_SHIFT.vehicle,
            ACCESS_SHIFT.access,
          ]
        : accessClass === 'motorcar'
          ? [
              ACCESS_SHIFT.motorcar,
              ACCESS_SHIFT.motorVehicle,
              ACCESS_SHIFT.vehicle,
              ACCESS_SHIFT.access,
            ]
          : [
              ACCESS_SHIFT.motorVehicle,
              ACCESS_SHIFT.vehicle,
              ACCESS_SHIFT.access,
            ];
    for (const shift of shifts) {
      const code = (bits >>> shift) & 0xf;
      if (code !== 0) return code;
    }
    return 0;
  };
  return (
    (BLOCKED_ACCESS.has(effective('motorcar')) ? 0 : 1) |
    (BLOCKED_ACCESS.has(effective('motor-vehicle')) ? 0 : 2) |
    (BLOCKED_ACCESS.has(effective('hgv')) ? 0 : 4)
  );
}

function segmentTileIds(segment, zoom) {
  const longitudeA = segment.longitudeAE7 / 10_000_000;
  const latitudeA = segment.latitudeAE7 / 10_000_000;
  const longitudeB = segment.longitudeBE7 / 10_000_000;
  const latitudeB = segment.latitudeBE7 / 10_000_000;
  if (Math.abs(longitudeA - longitudeB) > 180) {
    throw new Error(
      `Physical segment ${segment.segmentId} crosses the antimeridian; split it before indexing.`,
    );
  }
  const northWest = tileForCoordinate(
    Math.min(longitudeA, longitudeB),
    Math.max(latitudeA, latitudeB),
    zoom,
  );
  const southEast = tileForCoordinate(
    Math.max(longitudeA, longitudeB),
    Math.min(latitudeA, latitudeB),
    zoom,
  );
  const result = [];
  for (let x = northWest.x; x <= southEast.x; x += 1) {
    for (let y = northWest.y; y <= southEast.y; y += 1) {
      result.push(`${zoom}/${x}/${y}`);
    }
  }
  return result;
}

function tileForCoordinate(longitude, latitude, zoom) {
  const scale = 2 ** zoom;
  const clampedLatitude = Math.max(
    -85.0511288,
    Math.min(85.0511288, latitude),
  );
  const radians = (clampedLatitude * Math.PI) / 180;
  return {
    x: Math.min(
      scale - 1,
      Math.max(
        0,
        Math.floor(((longitude + 180) / 360) * scale),
      ),
    ),
    y: Math.min(
      scale - 1,
      Math.max(
        0,
        Math.floor(
          ((1 -
            Math.log(
              Math.tan(radians) + 1 / Math.cos(radians),
            ) /
              Math.PI) /
            2) *
            scale,
        ),
      ),
    ),
  };
}

function encodeTile(records) {
  const output = Buffer.alloc(
    TILE_HEADER_BYTES + records.length * RECORD_BYTES,
  );
  output.write(TILE_MAGIC, 0, 'ascii');
  output.writeUInt32LE(records.length, 4);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const offset = TILE_HEADER_BYTES + index * RECORD_BYTES;
    output.writeBigUInt64LE(BigInt(record.osmWayId), offset);
    output.writeBigUInt64LE(BigInt(record.nodeAId), offset + 8);
    output.writeBigUInt64LE(BigInt(record.nodeBId), offset + 16);
    output.writeInt32LE(record.longitudeAE7, offset + 24);
    output.writeInt32LE(record.latitudeAE7, offset + 28);
    output.writeInt32LE(record.longitudeBE7, offset + 32);
    output.writeInt32LE(record.latitudeBE7, offset + 36);
    output.writeUInt8(record.accessMask, offset + 40);
  }
  return output;
}

function uniqueNodePairRecords(segments) {
  const records = new Map();
  for (const segment of segments) {
    const key = [
      segment.nodeAId,
      segment.nodeBId,
      segment.osmWayId,
    ].join('|');
    const previous = records.get(key);
    if (!previous) {
      records.set(key, { ...segment });
      continue;
    }
    if (
      previous.edgeLengthDecimetres !==
      segment.edgeLengthDecimetres
    ) {
      throw new Error(
        `OSM node pair ${segment.nodeAId}/${segment.nodeBId} has inconsistent lengths.`,
      );
    }
    previous.accessMask |= segment.accessMask;
  }
  return [...records.values()];
}

function nodePairShard(nodeAId, nodeBId, shardBits) {
  let hash = 0x811c9dc5;
  const input = `${nodeAId}|${nodeBId}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> (32 - shardBits)) >>> 0;
}

function selectNodePairShards(
  records,
  requestedShardBits,
  maximumRecords,
) {
  const firstBits =
    requestedShardBits ?? MIN_NODE_PAIR_SHARD_BITS;
  const lastBits =
    requestedShardBits ?? MAX_NODE_PAIR_SHARD_BITS;
  for (
    let shardBits = firstBits;
    shardBits <= lastBits;
    shardBits += 1
  ) {
    const byShard = new Map();
    let largest = 0;
    for (const record of records) {
      const shard = nodePairShard(
        record.nodeAId,
        record.nodeBId,
        shardBits,
      );
      const values = byShard.get(shard) ?? [];
      values.push(record);
      byShard.set(shard, values);
      largest = Math.max(largest, values.length);
    }
    if (largest <= maximumRecords) {
      return { shardBits, byShard };
    }
  }
  throw new Error(
    requestedShardBits === undefined
      ? 'No safe node-pair shard width fits the mobile chunk budget.'
      : `Requested --node-pair-shard-bits=${requestedShardBits} exceeds the mobile chunk budget.`,
  );
}

function encodeNodePairShard(records) {
  const output = Buffer.alloc(
    NODE_PAIR_HEADER_BYTES +
      records.length * NODE_PAIR_RECORD_BYTES,
  );
  output.write(NODE_PAIR_MAGIC, 0, 'ascii');
  output.writeUInt32LE(records.length, 4);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const offset =
      NODE_PAIR_HEADER_BYTES +
      index * NODE_PAIR_RECORD_BYTES;
    output.writeBigUInt64LE(BigInt(record.nodeAId), offset);
    output.writeBigUInt64LE(BigInt(record.nodeBId), offset + 8);
    output.writeBigUInt64LE(BigInt(record.osmWayId), offset + 16);
    output.writeUInt32LE(
      record.edgeLengthDecimetres,
      offset + 24,
    );
    output.writeInt32LE(record.longitudeAE7, offset + 28);
    output.writeInt32LE(record.latitudeAE7, offset + 32);
    output.writeInt32LE(record.longitudeBE7, offset + 36);
    output.writeInt32LE(record.latitudeBE7, offset + 40);
    output.writeUInt8(record.accessMask, offset + 44);
  }
  return output;
}

function compareSegment(left, right) {
  return (
    left.osmWayId - right.osmWayId ||
    left.nodeAId - right.nodeAId ||
    left.nodeBId - right.nodeBId
  );
}

function compareNodePair(left, right) {
  return (
    left.nodeAId - right.nodeAId ||
    left.nodeBId - right.nodeBId ||
    left.osmWayId - right.osmWayId
  );
}

function validateGraph(graph) {
  if (
    !graph ||
    graph.format !== 'veyra-routing-graph' ||
    graph.formatVersion !== 1 ||
    !graph.metadata ||
    graph.metadata.coordinateScale !== 10_000_000 ||
    !Array.isArray(graph.metadata.bounds) ||
    graph.metadata.bounds.length !== 4 ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    !graph.metadata.counts
  ) {
    throw new Error('Input is not a supported Veyra routing graph.');
  }
  for (const value of graph.metadata.bounds) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Routing graph bounds are invalid.');
    }
  }
}

function coordinateE7(value, longitude, edgeId) {
  if (
    !Number.isSafeInteger(value) ||
    value < (longitude ? -1_800_000_000 : -850_511_288) ||
    value > (longitude ? 1_800_000_000 : 850_511_288)
  ) {
    throw new Error(`Routing edge ${edgeId} coordinate is invalid.`);
  }
  return value;
}

function safeIndex(value, length, label) {
  const result = nonNegativeSafeInteger(value, label);
  if (result >= length) throw new Error(`${label} is outside nodes.`);
  return result;
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function integerOption(value, fallback, minimum, maximum) {
  const parsed =
    value === undefined ? fallback : Number(String(value));
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `Integer option must be between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

function requiredIdentifier(value, name) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value)
  ) {
    throw new Error(`--${name} is missing or invalid.`);
  }
  return value;
}

function requiredRevision(value, name) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 96 ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new Error(`--${name} is missing or invalid.`);
  }
  return value;
}

function normalizedIsoDate(value, name) {
  if (
    typeof value !== 'string' ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`--${name} must be an ISO timestamp.`);
  }
  return new Date(value).toISOString();
}

function requiredSha256(value, name) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`--${name} must be a SHA-256 digest.`);
  }
  return value;
}

function requiredHttps(value, name) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error();
    return value;
  } catch {
    throw new Error(`--${name} must be an HTTPS URL.`);
  }
}

function requiredText(value, name, maximum) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum
  ) {
    throw new Error(`--${name} is missing or invalid.`);
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument ${token}.`);
    }
    const key = token
      .slice(2)
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${token}.`);
    }
    result[key] = value;
    index += 1;
  }
  for (const key of ['graph', 'output']) {
    if (!result[key]) throw new Error(`--${key} is required.`);
  }
  return result;
}

const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  buildRoadIdentityIndex(parseArgs(process.argv.slice(2)))
    .then((result) => {
      console.log(
        `Built ${result.output}\n` +
          `  ${result.physicalSegments} physical segments\n` +
          `  ${result.tiles} tiles / ${result.tileReferences} references\n` +
          `  ${result.nodePairShards} node-pair shards / ${result.nodePairRecords} records\n` +
          `  max ${result.maximumTileRecords} records per tile\n` +
          `  ${result.bytes} bytes\n` +
          `  sha256 ${result.sha256}\n` +
          `  directorySha256 ${result.directorySha256}`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
