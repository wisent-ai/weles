#!/usr/bin/env python3
"""Walk a Figma document file and write its summary, node list and vocabulary.

A separate process on purpose: a Figma file routinely exceeds the string
length Node can hold, so the document is parsed where that limit does not
apply. `src/figma/export-design-assets.mjs` calls it at export time, and
`wisent-components` runs it once more over a committed `document.json.gz`
whose export predates the vocabulary.

    parse-figma-document.py <document.json[.gz]> <summary.json> <nodes.json> [<vocabulary.json>]

The vocabulary is what the designer defined, resolved to values, and nothing
a regex over the raw file could tell apart from a pasted screenshot: every
colour variable bound to a fill or stroke (the REST file carries only the
alias, so the value is read off the paint it is bound to), every named style
with the value of the first node that uses it, the font families set on text,
the corner radii drawn, and per page the count of every gradient paint and
blur or shadow effect. Fills drawn without a variable are counted apart, so a
reader can tell a palette colour from a one-off.
"""
import gzip
import json
import sys
from collections import Counter, defaultdict

# Figma spells "as round as possible" as a radius in the thousands; that is a
# pill, not a length on the radius scale.
PILL = 1000


def channel(value):
    return max(0, min(255, round(float(value) * 255)))


def hex_of(color):
    return '#%02x%02x%02x' % (channel(color.get('r', 0)), channel(color.get('g', 0)), channel(color.get('b', 0)))


def visible(item):
    return isinstance(item, dict) and item.get('visible', True) is not False


def paint_value(paint):
    """The value a fill or stroke paints: a hex for a solid, stops for a gradient."""
    kind = paint.get('type', '')
    if kind == 'SOLID' and isinstance(paint.get('color'), dict):
        return hex_of(paint['color'])
    if kind.startswith('GRADIENT'):
        return {
            'type': kind,
            'stops': [hex_of(stop['color']) for stop in paint.get('gradientStops') or [] if isinstance(stop.get('color'), dict)],
        }
    return None


def effect_value(effect):
    value = {'type': effect.get('type', ''), 'radius': effect.get('radius')}
    if isinstance(effect.get('color'), dict):
        value['color'] = hex_of(effect['color'])
        value['alpha'] = round(float(effect['color'].get('a', 1)), 3)
    if isinstance(effect.get('offset'), dict):
        value['offset'] = [effect['offset'].get('x', 0), effect['offset'].get('y', 0)]
    if effect.get('spread') is not None:
        value['spread'] = effect['spread']
    return value


def text_value(style):
    return {key: style.get(key) for key in ('fontFamily', 'fontWeight', 'fontSize', 'lineHeightPx', 'letterSpacing') if style.get(key) is not None}


def radius_of(value):
    try:
        number = round(float(value) * 100) / 100
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def new_variable():
    return {'hexes': Counter(), 'uses': 0, 'pages': Counter()}


def new_page():
    return {'radii': set(), 'pills': 0, 'paints': Counter(), 'effects': Counter(), 'unboundFills': Counter()}


source, summary_path, nodes_path = sys.argv[1:4]
vocabulary_path = sys.argv[4] if len(sys.argv) > 4 else None
opener = gzip.open if source.endswith('.gz') else open
with opener(source, 'rb') as handle:
    payload = json.load(handle)

nodes = []
image_refs = set()
export_nodes = []
top_level_nodes = []
pages = []
variables = defaultdict(new_variable)
style_examples = {}
fonts = Counter()
by_page = defaultdict(new_page)

# A hidden layer and everything under it stays in the node list, which is an
# index of the file, and out of the vocabulary, which is what the design
# shows: the Untitled UI kit the pages were started from leaves its purple
# variables on hidden variant layers inside every instance.
stack = [(payload.get('document'), '', True)]
while stack:
    node, page, shown = stack.pop()
    if not isinstance(node, dict):
        continue
    nodes.append({'id': node.get('id'), 'name': node.get('name', ''), 'type': node.get('type', '')})
    if node.get('type') == 'CANVAS':
        page = node.get('name', '')
        pages.append(page)
        for child in node.get('children') or []:
            top_level_nodes.append({'id': child.get('id'), 'name': child.get('name', ''), 'page': page})
    shown = shown and node.get('visible', True) is not False
    settings = node.get('exportSettings')
    if isinstance(settings, list) and settings:
        export_nodes.append({'id': node.get('id'), 'name': node.get('name', ''), 'settings': settings})
    # Children go on the stack last-first, so they come off in document order.
    stack.extend((child, page, shown) for child in reversed(node.get('children') or []))
    if not shown:
        for kind in ('fills', 'strokes'):
            for paint in node.get(kind) or []:
                if isinstance(paint, dict) and paint.get('type') == 'IMAGE' and isinstance(paint.get('imageRef'), str):
                    image_refs.add(paint['imageRef'])
        continue
    stats = by_page[page]
    bound = node.get('boundVariables') or {}
    for kind in ('fills', 'strokes'):
        aliases = bound.get(kind) if isinstance(bound.get(kind), list) else []
        for index, paint in enumerate(node.get(kind) or []):
            if not isinstance(paint, dict):
                continue
            paint_type = paint.get('type', '')
            if paint_type == 'IMAGE' and isinstance(paint.get('imageRef'), str):
                image_refs.add(paint['imageRef'])
            if not visible(paint):
                continue
            if paint_type.startswith('GRADIENT'):
                stats['paints'][paint_type] += 1
            if paint_type != 'SOLID' or not isinstance(paint.get('color'), dict):
                continue
            colour = hex_of(paint['color'])
            alias = (paint.get('boundVariables') or {}).get('color')
            if not isinstance(alias, dict) and index < len(aliases) and isinstance(aliases[index], dict):
                alias = aliases[index]
            if isinstance(alias, dict) and alias.get('type') == 'VARIABLE_ALIAS' and isinstance(alias.get('id'), str):
                variable = variables[alias['id']]
                variable['hexes'][colour] += 1
                variable['uses'] += 1
                variable['pages'][page] += 1
            else:
                stats['unboundFills'][colour] += 1
    for effect in node.get('effects') or []:
        if visible(effect) and isinstance(effect.get('type'), str):
            stats['effects'][effect['type']] += 1
    for value in [node.get('cornerRadius')] + list(node.get('rectangleCornerRadii') or []):
        radius = radius_of(value)
        if radius is None:
            continue
        if radius >= PILL:
            stats['pills'] += 1
        else:
            stats['radii'].add(radius)
    if node.get('type') == 'TEXT' and isinstance(node.get('style'), dict) and node['style'].get('fontFamily'):
        fonts[node['style']['fontFamily']] += 1
    for kind, style_id in (node.get('styles') or {}).items():
        if not isinstance(style_id, str) or style_id in style_examples:
            continue
        if kind in ('fill', 'fills', 'stroke', 'strokes'):
            paints = [paint for paint in node.get('fills' if kind.startswith('fill') else 'strokes') or [] if visible(paint)]
            values = [value for value in (paint_value(paint) for paint in paints) if value is not None]
            if values:
                style_examples[style_id] = values[0] if len(values) == 1 else values
        elif kind == 'text' and isinstance(node.get('style'), dict):
            style_examples[style_id] = text_value(node['style'])
        elif kind == 'effect':
            style_examples[style_id] = [effect_value(effect) for effect in node.get('effects') or [] if visible(effect)]

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

if vocabulary_path:
    vocabulary = {
        'schemaVersion': 1,
        'name': payload.get('name'),
        'version': str(payload.get('version', '')),
        'lastModified': payload.get('lastModified'),
        'pages': pages,
        'variables': {
            variable_id: {
                'hex': variable['hexes'].most_common(1)[0][0],
                'hexes': dict(variable['hexes'].most_common()),
                'uses': variable['uses'],
                'pages': dict(variable['pages'].most_common()),
            }
            for variable_id, variable in sorted(variables.items(), key=lambda item: -item[1]['uses'])
        },
        'styles': {
            style_id: {
                'name': meta.get('name', ''),
                'styleType': meta.get('styleType', ''),
                'remote': bool(meta.get('remote', False)),
                'value': style_examples.get(style_id),
            }
            for style_id, meta in (payload.get('styles') or {}).items()
            if isinstance(meta, dict)
        },
        'fonts': dict(fonts.most_common()),
        'byPage': {
            page: {
                'radii': sorted(stats['radii']),
                'pills': stats['pills'],
                'paints': dict(stats['paints'].most_common()),
                'effects': dict(stats['effects'].most_common()),
                'unboundFills': dict(stats['unboundFills'].most_common()),
            }
            for page, stats in by_page.items()
            if page
        },
    }
    with open(vocabulary_path, 'w', encoding='utf-8') as handle:
        json.dump(vocabulary, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
