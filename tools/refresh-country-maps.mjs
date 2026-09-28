#!/usr/bin/env node
// Public map-data tooling only. No application, user data or credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'officialtechnologytimeline-dot/veyra-offline-maps';
const PUBLIC = `https://github.com/${REPO}`;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const run = (program, args) => execFileSync(program, args, { stdio: 'inherit', timeout: 900_000 });
const node = (script, args) => run(process.execPath, [path.join(ROOT, script), ...args]);
const pmtiles = process.env.PMTILES_BIN || 'pmtiles';
// Explicitly commissioned, tested country profiles only. Never invent downloads.
const profiles = [{ id: 'mc', source: 'https://download.geofabrik.de/europe/monaco-latest.osm.pbf',
  maxPbfBytes: 5_000_000, maxMapBytes: 30_000_000, minNodes: 6000,
  maxUnsupportedTurns: 2, maxUnparsedRestrictions: 7,
  probes: ['Carrefour', 'Casino de Monte Carlo', 'Musée Océanographique'] }];

async function download(url, file, limit) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Download HTTP ${response.status}: ${url}`);
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Source exceeds reviewed size budget');
  const output = await fs.open(file, 'wx');
  let size = 0; const hash = crypto.createHash('sha256');
  try {
    for await (const bytes of response.body) {
      size += bytes.length; if (size > limit) throw new Error('Download size budget exceeded');
      hash.update(bytes); await output.write(bytes);
    }
  } finally { await output.close(); }
  if (!size) throw new Error('Empty source');
  return { bytes: size, sha256: hash.digest('hex') };
}

function validateGraph(graph, country, profile) {
  const { nodes, edges, metadata } = graph;
  if (graph.format !== 'veyra-routing-graph' || metadata.id !== `${country.id}-routing` ||
      metadata.revision !== country.revision || nodes.length !== metadata.counts.nodes ||
      edges.length !== metadata.counts.directedEdges || nodes.length < profile.minNodes) throw new Error('Invalid/truncated routing graph');
  const inside = (lon, lat) => lon >= country.bounds[0] && lat >= country.bounds[1] && lon <= country.bounds[2] && lat <= country.bounds[3];
  if (nodes.some((n) => !inside(n[0] / metadata.coordinateScale, n[1] / metadata.coordinateScale))) throw new Error('Nodes outside map coverage');
  if (edges.some((e) => !Number.isInteger(e[0]) || !Number.isInteger(e[1]) || e[0] < 0 || e[1] < 0 ||
      e[0] >= nodes.length || e[1] >= nodes.length || !Number.isFinite(e[4]) || e[4] <= 0)) throw new Error('Broken graph edge');
  const warnings = metadata.buildWarnings;
  if (warnings.missingWayNodes || warnings.unsupportedTurnRestrictions > profile.maxUnsupportedTurns ||
      warnings.unparsedPhysicalRestrictions > profile.maxUnparsedRestrictions) throw new Error('New unresolved routing restrictions require review');
  if (graph.turnRestrictions.length !== metadata.counts.turnRestrictions ||
      graph.turnRestrictions.some((r) => !Number.isInteger(r.viaNode) || r.viaNode < 0 || r.viaNode >= nodes.length)) throw new Error('Broken turn restriction');
  return inside;
}

export async function buildCountry(profile, previous, work, builds) {
  const sourceDir = path.join(work, 'source');
  await fs.mkdir(sourceDir, { recursive: true });
  const pbf = path.join(sourceDir, `${profile.id}.osm.pbf`);
  const sourceHash = await download(profile.source, pbf, profile.maxPbfBytes);
  const sourceJson = path.join(sourceDir, `${profile.id}.json`);
  run(process.env.PYTHON_BIN || 'python3', [path.join(ROOT, 'convert-country-pbf.py'), '--input', pbf, '--output', sourceJson]);
  const source = await json(sourceJson);
  const dataTimestamp = source.osm3s.timestamp_osm_base;
  if (!Number.isFinite(Date.parse(dataTimestamp)) || Date.parse(dataTimestamp) > Date.now() ||
      Date.parse(dataTimestamp) < Date.parse(previous.dataTimestamp)) throw new Error('Invalid/stale source timestamp');
  const datedSourceUrl = profile.source.replace('-latest.osm.pbf', `-${dataTimestamp.slice(2, 10).replaceAll('-', '')}.osm.pbf`);
  const datedHash = await download(datedSourceUrl, path.join(sourceDir, 'dated.osm.pbf'), profile.maxPbfBytes);
  if (datedHash.sha256 !== sourceHash.sha256) throw new Error('Dated upstream archive does not match captured source');
  const build = builds.filter((b) => /^\d{8}\.pmtiles$/.test(b.key) && b.version === previous.mapSchema.version)
    .sort((a, b) => b.key.localeCompare(a.key))[0];
  if (!build || Date.now() - Date.parse(build.uploaded) > 10 * 86_400_000) throw new Error('No recent compatible basemap; keeping installed release');
  const revision = `${dataTimestamp.slice(0, 10).replaceAll('-', '.')}-b${String(process.env.GITHUB_RUN_NUMBER || Date.now())}`;
  const tag = `${profile.id}-${revision}`;
  const releaseUrl = `${PUBLIC}/releases/download/${tag}`;
  const output = path.join(work, tag); await fs.mkdir(output);
  const country = { ...previous, revision, dataTimestamp, releasedAt: new Date().toISOString(),
    source: `OpenStreetMap · Geofabrik ${dataTimestamp.slice(0, 10)} · Protomaps ${build.key.slice(0, 8)}`,
    provenance: { ...previous.provenance, sourceArchiveUrl: datedSourceUrl, buildPipelineVersion: '1.1.0' } };
  const graphPath = path.join(work, `${profile.id}.graph.json`);
  node('build-routing-graph.mjs', ['--input', sourceJson, '--output', graphPath, '--id', `${profile.id}-routing`, '--revision', revision]);
  const graph = await json(graphPath);
  const inside = validateGraph(graph, country, profile);
  const files = {
    basemap: path.join(output, `${tag}.pmtiles`), routing: path.join(output, `${tag}.vgraph`),
    search: path.join(output, `${tag}.vsearch`), 'road-identity': path.join(output, `${tag}.vrid`),
  };
  node('pack-routing-graph.mjs', ['--input', graphPath, '--output', files.routing, '--manifest', path.join(work, 'routing.manifest.json')]);
  node('build-offline-search-index.mjs', ['--input', sourceJson, '--output', files.search, '--region-id', profile.id, '--region-name', previous.names.en]);
  node('build-road-identity-index.mjs', ['--graph', graphPath, '--output', files['road-identity'],
    '--publisher-id', previous.provenance.publisherId, '--dataset-id', previous.provenance.datasetId,
    '--source-archive-url', `${releaseUrl}/${profile.id}.json`, '--license', previous.attribution.sourceLicense,
    '--rights-notice-url', previous.provenance.rightsNoticeUrl, '--build-pipeline-id', previous.provenance.buildPipelineId,
    '--build-pipeline-version', '1.1.0']);
  const index = await json(files.search);
  if (index.format !== 'veyra.offline-search' || index.version !== 2 || index.region.id !== profile.id ||
      index.entries.length < previous.searchCoverage.totalEntries * 0.8 ||
      index.entries.some((e) => !inside(e[2] / 1e6, e[3] / 1e6))) throw new Error('Invalid/incomplete search index');
  for (const probe of profile.probes) if (!index.entries.some((e) => e[0].toLowerCase().includes(probe.toLowerCase()))) throw new Error(`Missing real place: ${probe}`);
  const basemapUrl = `https://build.protomaps.com/${build.key}`;
  run(pmtiles, ['extract', basemapUrl, files.basemap, `--bbox=${country.bounds.join(',')}`, '--maxzoom=15', '--download-threads=2']);
  run(pmtiles, ['verify', files.basemap]);
  const mapMetadata = JSON.parse(execFileSync(pmtiles, ['show', files.basemap, '--metadata'], { encoding: 'utf8' }));
  const mapHeader = JSON.parse(execFileSync(pmtiles, ['show', files.basemap, '--header-json'], { encoding: 'utf8' }));
  if (mapMetadata.version !== country.mapSchema.version || mapHeader.bounds[0] > country.bounds[0] ||
      mapHeader.bounds[1] > country.bounds[1] || mapHeader.bounds[2] < country.bounds[2] || mapHeader.bounds[3] < country.bounds[3]) throw new Error('Basemap schema/coverage mismatch');
  const roles = { basemap: ['pmtiles', 3], routing: ['vgraph', 2], search: ['vsearch', 2], 'road-identity': ['vrid', 1] };
  country.artifacts = [];
  for (const [role, file] of Object.entries(files)) {
    const bytes = await fs.readFile(file); const fileName = path.basename(file);
    if (!bytes.length || bytes.length > profile.maxMapBytes) throw new Error('Artifact exceeds reviewed mobile size budget');
    if (role === 'routing' && (bytes.subarray(0, 8).toString() !== 'VYRGRPH2' ||
        JSON.parse(bytes.subarray(12, 12 + bytes.readUInt32LE(8))).graph.metadata.revision !== revision)) throw new Error('Routing binary identity mismatch');
    if (role === 'road-identity' && (bytes.subarray(0, 8).toString() !== 'VYRIDX01' ||
        sha(bytes.subarray(44, 44 + bytes.readUInt32LE(8))) !== bytes.subarray(12, 44).toString('hex'))) throw new Error('Road identity integrity mismatch');
    country.artifacts.push({ id: `${profile.id}-${role}`, role, format: roles[role][0], formatVersion: roles[role][1],
      fileName, bytes: bytes.length, sha256: sha(bytes), url: `${releaseUrl}/${fileName}`,
      ...(role === 'road-identity' ? { directorySha256: bytes.subarray(12, 44).toString('hex') } : {}) });
  }
  country.totalBytes = country.artifacts.reduce((n, a) => n + a.bytes, 0);
  const counts = { a: 0, s: 0, p: 0, r: 0 }; for (const entry of index.entries) counts[entry[4]]++;
  country.searchCoverage = { totalEntries: index.entries.length, addressEntries: counts.a,
    streetEntries: counts.s, placeEntries: counts.p, roadReferenceEntries: counts.r };
  await fs.copyFile(pbf, path.join(output, `${profile.id}.osm.pbf`));
  await fs.copyFile(sourceJson, path.join(output, `${profile.id}.json`));
  await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ country: profile.id, revision, sourceHash,
    dataTimestamp, basemapUrl, mapHeader, searchCoverage: country.searchCoverage,
    routingCounts: graph.metadata.counts, buildWarnings: graph.metadata.buildWarnings,
    status: 'AUTOMATED_DATA_CHECKS_PASSED_BETA', note: 'Not a substitute for device or road-navigation acceptance tests.' }, null, 2));
  return { country, tag, output };
}

async function main() {
  const catalogPath = path.resolve(process.argv[2] || 'catalog.json');
  const workRoot = path.resolve(process.argv[3] || 'map-work');
  const buildOnly = process.argv.includes('--build-only');
  const catalog = await json(catalogPath);
  if (catalog.catalogVersion !== 3) throw new Error('Unsupported catalog version');
  const metadataResponse = await fetch('https://build-metadata.protomaps.dev/builds.json', { signal: AbortSignal.timeout(30_000) });
  if (!metadataResponse.ok) throw new Error('Protomaps index unavailable');
  const builds = await metadataResponse.json();
  for (const profile of profiles) {
    const previous = catalog.countries.find((c) => c.id === profile.id);
    if (!previous) continue;
    const work = path.join(workRoot, profile.id); await fs.mkdir(work, { recursive: true });
    const result = await buildCountry(profile, previous, work, builds);
    const candidate = { ...catalog, generatedAt: new Date().toISOString(),
      countries: catalog.countries.map((c) => c.id === profile.id ? result.country : c) };
    await fs.writeFile(path.join(result.output, 'catalog.candidate.json'), JSON.stringify(candidate, null, 2) + '\n');
    if (buildOnly) { console.log(`Build verified, not published: ${result.output}`); continue; }
    if (process.env.GITHUB_REPOSITORY !== REPO || !process.env.GH_TOKEN) throw new Error('Publication requires this repository Actions context');
    const assets = (await fs.readdir(result.output)).map((name) => path.join(result.output, name));
    run('gh', ['release', 'create', result.tag, ...assets, '--repo', REPO, '--target', 'main', '--prerelease',
      '--title', `${previous.names.en} · ${result.country.dataTimestamp.slice(0, 10)} · beta`,
      '--notes', 'Automatically rebuilt from OpenStreetMap/Geofabrik and Protomaps. Data checks, source dates and known limitations: verification.json. Attribution and ODbL: ATTRIBUTION.md. Offline data has no current traffic or closures.']);
    // Publish catalog only after each actual anonymous download matches its checksum.
    for (const artifact of result.country.artifacts) {
      const downloaded = await download(artifact.url, path.join(work, `verified-${artifact.fileName}`), artifact.bytes);
      if (downloaded.bytes !== artifact.bytes || downloaded.sha256 !== artifact.sha256) throw new Error('Published artifact checksum mismatch; catalog unchanged');
    }
    await fs.writeFile(catalogPath, JSON.stringify(candidate, null, 2) + '\n');
    run('git', ['add', '--', catalogPath]);
    run('git', ['-c', 'user.name=Technology Timeline Maps', '-c', 'user.email=maps@users.noreply.github.com',
      'commit', '-m', `Update verified ${profile.id} map ${result.country.revision}`]);
    run('git', ['push', 'origin', 'HEAD:main']);
    Object.assign(catalog, candidate);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exitCode = 1; });
