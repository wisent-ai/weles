#!/usr/bin/env python3
import json
import sys

source, summary_path, nodes_path = sys.argv[1:4]
with open(source, 'rb') as handle:
    payload = json.load(handle)

nodes = []
image_refs = set()
export_nodes = []
top_level_nodes = []
stack = [payload.get('document')]
while stack:
    node = stack.pop()
    if not isinstance(node, dict):
        continue
    nodes.append({'id': node.get('id'), 'name': node.get('name', ''), 'type': node.get('type', '')})
    for paint in list(node.get('fills') or []) + list(node.get('strokes') or []):
        if isinstance(paint, dict) and paint.get('type') == 'IMAGE' and isinstance(paint.get('imageRef'), str):
            image_refs.add(paint['imageRef'])
    settings = node.get('exportSettings')
    if isinstance(settings, list) and settings:
        export_nodes.append({'id': node.get('id'), 'name': node.get('name', ''), 'settings': settings})
    if node.get('type') == 'CANVAS':
        for child in node.get('children') or []:
            top_level_nodes.append({'id': child.get('id'), 'name': child.get('name', ''), 'page': node.get('name', '')})
    stack.extend(node.get('children') or [])

summary = {
    'version': str(payload.get('version', '')),
    'lastModified': payload.get('lastModified'),
    'components': len(payload.get('components') or {}),
    'componentSets': len(payload.get('componentSets') or {}),
    'styles': len(payload.get('styles') or {}),
    'imageRefs': sorted(image_refs),
    'exportNodes': export_nodes,
    'topLevelNodes': top_level_nodes,
}
with open(summary_path, 'w', encoding='utf-8') as handle:
    json.dump(summary, handle, ensure_ascii=False, separators=(',', ':'))
with open(nodes_path, 'w', encoding='utf-8') as handle:
    json.dump(nodes, handle, ensure_ascii=False, separators=(',', ':'))
