#!/usr/bin/env python3
"""Convert a local, dated OSM PBF into the existing VEYRA build input.

Requires pyosmium 4.3.1. No network access, contributor personal metadata, or
guessed timestamps. Streaming output bounds converter memory independently of
country size; downstream graph/index builders still need sufficient build RAM.
"""
import argparse
import json
from pathlib import Path
import osmium


class Exporter(osmium.SimpleHandler):
    def __init__(self, output):
        super().__init__()
        self.output = output
        self.count = 0

    def emit(self, element):
        if self.count:
            self.output.write(',')
        json.dump(element, self.output, ensure_ascii=False, separators=(',', ':'))
        self.count += 1

    def node(self, node):
        if node.location.valid():
            self.emit(dict(type='node', id=node.id, lat=node.location.lat,
                           lon=node.location.lon, tags=dict(node.tags)))

    def way(self, way):
        self.emit(dict(type='way', id=way.id, nodes=[n.ref for n in way.nodes],
                       tags=dict(way.tags)))

    def relation(self, relation):
        tags = dict(relation.tags)
        if tags.get('type') == 'restriction':
            types = {'n': 'node', 'w': 'way', 'r': 'relation'}
            self.emit(dict(type='relation', id=relation.id, tags=tags, members=[
                dict(type=types[m.type], ref=m.ref, role=m.role) for m in relation.members
            ]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    with osmium.io.Reader(str(args.input)) as reader:
        timestamp = reader.header().get('osmosis_replication_timestamp')
    if not timestamp:
        raise ValueError('The PBF must contain a real OSM replication timestamp.')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as output:
        metadata = dict(version=0.6, generator='VEYRA country-pbf 1.0.0', osm3s=dict(
            timestamp_osm_base=timestamp,
            copyright='© OpenStreetMap contributors. Open Database License (ODbL) 1.0.',
        ))
        output.write(json.dumps(metadata, ensure_ascii=False)[:-1] + ',"elements":[')
        exporter = Exporter(output)
        exporter.apply_file(str(args.input))
        output.write(']}\n')
    print(json.dumps(dict(elements=exporter.count, timestamp=timestamp,
                         output=str(args.output), bytes=args.output.stat().st_size)))


if __name__ == '__main__':
    main()
