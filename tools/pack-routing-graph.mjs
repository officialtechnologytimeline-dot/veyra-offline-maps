#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const MAGIC = Buffer.from('VYRGRPH2', 'ascii');
const PREFIX_BYTES = MAGIC.byteLength + 4;

const COLUMN_DEFINITIONS = [
  ['nodeLongitudeE7', 'i32'],
  ['nodeLatitudeE7', 'i32'],
  ['nodeOsmId', 'f64'],
  ['edgeFrom', 'u32'],
  ['edgeTo', 'u32'],
  ['edgeWayId', 'u32'],
  ['edgeSegmentId', 'u32'],
  ['edgeLengthDecimetres', 'u32'],
  ['edgeRoadClass', 'u8'],
  ['edgeFlags', 'u8'],
  ['edgeMaxSpeedKph', 'u8'],
  ['edgeNameStringId', 'i16'],
  ['edgeRefStringId', 'i16'],
  ['edgeSurfaceStringId', 'i16'],
  ['edgeAccessBits', 'u32'],
  ['edgeMaxHeightCentimetres', 'u16'],
  ['edgeMaxWidthCentimetres', 'u16'],
  ['edgeMaxLengthCentimetres', 'u16'],
  ['edgeMaxWeightKilograms', 'u32'],
];

const TYPE = {
  i16: { bytes: 2, create: (length) => new Int16Array(length) },
  u16: { bytes: 2, create: (length) => new Uint16Array(length) },
  i32: { bytes: 4, create: (length) => new Int32Array(length) },
  u32: { bytes: 4, create: (length) => new Uint32Array(length) },
  f64: { bytes: 8, create: (length) => new Float64Array(length) },
  u8: { bytes: 1, create: (length) => new Uint8Array(length) },
};

function usage() {
  return `
Pack a generated tuple-JSON graph into the zero-copy mobile binary format.

Usage:
  node scripts/pack-routing-graph.mjs \\
    --input data/generated/torino-routing-20260725.graph.json \\
    --output assets/routing/torino-v2.vgraph \\
    --manifest assets/routing/torino-v2.vgraph.manifest.json
`.trim();
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index], argv[index + 1]);
  }
  const input = values.get('--input');
  const output = values.get('--output');
  const manifest = values.get('--manifest');
  if (!input?.endsWith('.json')) {
    throw new Error('--input must be a generated graph JSON file.');
  }
  if (!output?.endsWith('.vgraph')) {
    throw new Error('--output must end in .vgraph.');
  }
  if (!manifest?.endsWith('.json')) {
    throw new Error('--manifest must end in .json.');
  }
  return {
    inputPath: resolve(input),
    outputPath: resolve(output),
    manifestPath: resolve(manifest),
  };
}

function align(value, bytes) {
  return Math.ceil(value / bytes) * bytes;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

function makeColumns(graph) {
  const nodeCount = graph.nodes.length;
  const edgeCount = graph.edges.length;
  const lengths = {
    nodeLongitudeE7: nodeCount,
    nodeLatitudeE7: nodeCount,
    nodeOsmId: nodeCount,
    edgeFrom: edgeCount,
    edgeTo: edgeCount,
    edgeWayId: edgeCount,
    edgeSegmentId: edgeCount,
    edgeLengthDecimetres: edgeCount,
    edgeRoadClass: edgeCount,
    edgeFlags: edgeCount,
    edgeMaxSpeedKph: edgeCount,
    edgeNameStringId: edgeCount,
    edgeRefStringId: edgeCount,
    edgeSurfaceStringId: edgeCount,
    edgeAccessBits: edgeCount,
    edgeMaxHeightCentimetres: edgeCount,
    edgeMaxWidthCentimetres: edgeCount,
    edgeMaxLengthCentimetres: edgeCount,
    edgeMaxWeightKilograms: edgeCount,
  };
  const columns = Object.fromEntries(
    COLUMN_DEFINITIONS.map(([name, type]) => [
      name,
      TYPE[type].create(lengths[name]),
    ]),
  );
  const integer = (value, minimum, maximum, label) => {
    if (
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw new Error(`${label} is outside the binary v2 range.`);
    }
    return value;
  };

  for (let nodeId = 0; nodeId < nodeCount; nodeId += 1) {
    const node = graph.nodes[nodeId];
    columns.nodeLongitudeE7[nodeId] = integer(
      node[0],
      -0x8000_0000,
      0x7fff_ffff,
      `Node ${nodeId} longitude`,
    );
    columns.nodeLatitudeE7[nodeId] = integer(
      node[1],
      -0x8000_0000,
      0x7fff_ffff,
      `Node ${nodeId} latitude`,
    );
    columns.nodeOsmId[nodeId] = integer(
      node[2],
      1,
      Number.MAX_SAFE_INTEGER,
      `Node ${nodeId} OSM id`,
    );
  }
  for (let edgeId = 0; edgeId < edgeCount; edgeId += 1) {
    const edge = graph.edges[edgeId];
    const label = (field) => `Edge ${edgeId} ${field}`;
    columns.edgeFrom[edgeId] = integer(
      edge[0], 0, 0xffff_ffff, label('from'),
    );
    columns.edgeTo[edgeId] = integer(
      edge[1], 0, 0xffff_ffff, label('to'),
    );
    columns.edgeWayId[edgeId] = integer(
      edge[2], 0, 0xffff_ffff, label('way id'),
    );
    columns.edgeSegmentId[edgeId] = integer(
      edge[3], 0, 0xffff_ffff, label('segment id'),
    );
    columns.edgeLengthDecimetres[edgeId] = integer(
      edge[4], 1, 0xffff_ffff, label('length'),
    );
    columns.edgeRoadClass[edgeId] = integer(
      edge[5], 0, 0xff, label('road class'),
    );
    columns.edgeFlags[edgeId] = integer(
      edge[6], 0, 0xff, label('flags'),
    );
    columns.edgeMaxSpeedKph[edgeId] = integer(
      edge[7], 0, 0xff, label('max speed'),
    );
    columns.edgeNameStringId[edgeId] = integer(
      edge[8], -1, 0x7fff, label('name string id'),
    );
    columns.edgeRefStringId[edgeId] = integer(
      edge[9], -1, 0x7fff, label('ref string id'),
    );
    columns.edgeSurfaceStringId[edgeId] = integer(
      edge[10], -1, 0x7fff, label('surface string id'),
    );
    columns.edgeAccessBits[edgeId] = integer(
      edge[11], 0, 0xffff_ffff, label('access bits'),
    );
    columns.edgeMaxHeightCentimetres[edgeId] = integer(
      edge[12], 0, 0xffff, label('max height'),
    );
    columns.edgeMaxWidthCentimetres[edgeId] = integer(
      edge[13], 0, 0xffff, label('max width'),
    );
    columns.edgeMaxLengthCentimetres[edgeId] = integer(
      edge[14], 0, 0xffff, label('max length'),
    );
    columns.edgeMaxWeightKilograms[edgeId] = integer(
      edge[15], 0, 0xffff_ffff, label('max weight'),
    );
  }
  return columns;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await refuseExisting([options.outputPath, options.manifestPath]);
  const sourceBytes = await readFile(options.inputPath);
  const graph = JSON.parse(sourceBytes.toString('utf8'));
  if (
    graph.format !== 'veyra-routing-graph' ||
    graph.formatVersion !== 1 ||
    graph.nodes?.length !== graph.metadata?.counts?.nodes ||
    graph.edges?.length !== graph.metadata?.counts?.directedEdges
  ) {
    throw new Error('Input is not a valid Veyra tuple graph.');
  }

  const columns = makeColumns(graph);
  const header = {
    format: 'veyra-routing-binary',
    formatVersion: 2,
    byteOrder: 'LE',
    graph: {
      format: graph.format,
      formatVersion: graph.formatVersion,
      metadata: graph.metadata,
      strings: graph.strings,
      turnRestrictions: graph.turnRestrictions,
      speedCameras: graph.speedCameras,
    },
    columns: COLUMN_DEFINITIONS.map(([name, type]) => ({
      name,
      type,
      count: columns[name].length,
    })),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  let totalBytes = align(PREFIX_BYTES + headerBytes.byteLength, 8);
  for (const [name, type] of COLUMN_DEFINITIONS) {
    totalBytes = align(totalBytes, TYPE[type].bytes);
    totalBytes += columns[name].byteLength;
  }

  const packed = Buffer.allocUnsafe(totalBytes);
  packed.fill(0, 0, align(PREFIX_BYTES + headerBytes.byteLength, 8));
  MAGIC.copy(packed, 0);
  packed.writeUInt32LE(headerBytes.byteLength, MAGIC.byteLength);
  headerBytes.copy(packed, PREFIX_BYTES);
  let offset = align(PREFIX_BYTES + headerBytes.byteLength, 8);
  for (const [name, type] of COLUMN_DEFINITIONS) {
    offset = align(offset, TYPE[type].bytes);
    const column = columns[name];
    Buffer.from(
      column.buffer,
      column.byteOffset,
      column.byteLength,
    ).copy(packed, offset);
    offset += column.byteLength;
  }
  if (offset !== packed.byteLength) {
    throw new Error('Packed graph length calculation failed.');
  }

  const digest = sha256(packed);
  const manifest = {
    manifestVersion: 2,
    generatedAt: new Date().toISOString(),
    graph: {
      id: graph.metadata.id,
      revision: graph.metadata.revision,
      format: 'veyra-routing-binary',
      formatVersion: 2,
      schema: 'typed-columns-le-v2',
      fileName: basename(options.outputPath),
      bytes: packed.byteLength,
      sha256: digest,
      source: {
        fileName: basename(options.inputPath),
        bytes: sourceBytes.byteLength,
        sha256: sha256(sourceBytes),
      },
      bounds: graph.metadata.bounds,
      counts: graph.metadata.counts,
    },
  };

  await atomicWrite(options.outputPath, packed);
  await atomicWrite(
    options.manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(
    `Packed ${options.outputPath}\n` +
      `  ${(packed.byteLength / 1_048_576).toFixed(1)} MiB\n` +
      `  sha256 ${digest}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 1;
});
