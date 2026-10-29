#!/usr/bin/env python3
"""Validate one PROV-JSON document and read the four audit answers back out of it.

Reads the document on stdin. Exits 1, printing why, unless all four checks pass:

1. It validates against the W3C PROV-JSON schema (prov-json.schema.json beside this file,
   from the Member Submission at https://www.w3.org/submissions/prov-json/schema, unchanged:
   SHA-256 39e79eec9f4a0c40f5177acced678b97e612b483671fd4edc77af46c8502fb36).
2. The `prov` package (https://pypi.org/project/prov/), the reference Python PROV
   implementation, deserializes it.
3. What neither check above enforces, because the schema has no cross-references and
   `prov` is lenient: every element a relation names is declared, and is the kind PROV-DM
   requires there (an entity, an activity or an agent); every time is an xsd:dateTime
   (`prov` turns one it cannot parse into nothing); every prefix is an absolute URI (with an
   authority, or a urn:); and every qualified name uses a declared prefix.
4. Six rules of the W3C PROV-CONSTRAINTS recommendation (https://www.w3.org/TR/prov-constraints/).
   Constraint 55 (entity-activity-disjoint): no identifier is both an entity
   and an activity. Constraint 42 (derivation-generation-generation-ordering): an entity's
   generation strictly precedes the generation of anything derived from it, and every
   entity has a generation (inference 7), so a derivation cycle, self-derivation included,
   orders an event strictly before itself and makes the instance invalid whatever the times
   say. Constraints 30 (start-precedes-end), 33 (usage-within-activity), 34
   (generation-within-activity) and 37 (generation-precedes-usage) order events; the
   recommendation checks them on events and says an application MAY flag times that
   contradict them, and SHOULD write one timeline per instance. Willder writes every time
   from one clock, so a time that contradicts one of these four is a defect in the
   document, and this validator refuses it. "Precedes" allows equal times, as the
   recommendation defines it. A bound that is not stated (an activity without an end time)
   constrains nothing. No other constraint is checked; 51
   (impossible-unspecified-derivation-generation-use), for one, needs a derivation's
   prov:generation or prov:usage, which the exporter never writes.

It then prints, as JSON, the answers as `prov` parsed them, never by re-reading the raw
JSON: the writer, the authority it acted for, the authorizing audit row, the source, each
reader's read, and the versions replaced and replacing. A test compares these with what
the audit API answers, which is the round trip. Every actor's willder:actorType (human,
agent or extraction) must agree with whether it is a prov:Person.

Needs: pip install --no-deps -r scripts/prov/requirements.txt
"""
from datetime import timezone
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlparse

import jsonschema
from prov.model import (
    PROV_ATTR_ACTIVITY, PROV_ATTR_AGENT, PROV_ATTR_DELEGATE, PROV_ATTR_ENDTIME, PROV_ATTR_ENTITY,
    PROV_ATTR_GENERATED_ENTITY, PROV_ATTR_PLAN, PROV_ATTR_RESPONSIBLE, PROV_ATTR_STARTTIME,
    PROV_ATTR_TIME, PROV_ATTR_USED_ENTITY, PROV_TYPE, ProvActivity, ProvAgent, ProvAssociation,
    ProvAttribution, ProvDelegation,
    ProvDerivation, ProvDocument, ProvElement, ProvEntity, ProvGeneration, ProvRelation,
    ProvUsage,
)
from prov.model.records import parse_xsd_datetime

SCHEMA = json.loads((Path(__file__).parent / 'prov-json.schema.json').read_text())

# For each relation this document uses, the element kind PROV-DM requires behind each of
# its element-valued formal attributes, and which of those attributes it requires at all.
KINDS = {
    ProvGeneration: {PROV_ATTR_ENTITY: ProvEntity, PROV_ATTR_ACTIVITY: ProvActivity},
    ProvUsage: {PROV_ATTR_ACTIVITY: ProvActivity, PROV_ATTR_ENTITY: ProvEntity},
    ProvAttribution: {PROV_ATTR_ENTITY: ProvEntity, PROV_ATTR_AGENT: ProvAgent},
    ProvAssociation: {PROV_ATTR_ACTIVITY: ProvActivity, PROV_ATTR_AGENT: ProvAgent, PROV_ATTR_PLAN: ProvEntity},
    ProvDelegation: {PROV_ATTR_DELEGATE: ProvAgent, PROV_ATTR_RESPONSIBLE: ProvAgent, PROV_ATTR_ACTIVITY: ProvActivity},
    ProvDerivation: {PROV_ATTR_GENERATED_ENTITY: ProvEntity, PROV_ATTR_USED_ENTITY: ProvEntity, PROV_ATTR_ACTIVITY: ProvActivity},
}
REQUIRED = {
    ProvGeneration: (PROV_ATTR_ENTITY,),
    ProvUsage: (PROV_ATTR_ACTIVITY,),
    ProvAttribution: (PROV_ATTR_ENTITY, PROV_ATTR_AGENT),
    ProvAssociation: (PROV_ATTR_ACTIVITY,),
    ProvDelegation: (PROV_ATTR_DELEGATE, PROV_ATTR_RESPONSIBLE),
    ProvDerivation: (PROV_ATTR_GENERATED_ENTITY, PROV_ATTR_USED_ENTITY),
}
TIME_KEYS = ('prov:time', 'prov:startTime', 'prov:endTime')
# The audit trail's actor types: a person, an agent, or the system itself (a connector sync).
ACTOR_TYPES = ('human', 'agent', 'extraction')
BUILT_IN_PREFIXES = {'prov', 'xsd'}
# RFC 8141: "urn:", a namespace identifier, ":", and a non-empty namespace-specific string.
URN = re.compile(r'^urn:[A-Za-z0-9][A-Za-z0-9-]{0,30}[A-Za-z0-9]:\S+$', re.IGNORECASE)


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def one(record, name):
    """The single value of an extension attribute such as willder:actorId, or None."""
    values = [v for k, v in record.attributes if k.localpart == name]
    return str(values[0]) if values else None


def has_type(record, local_name):
    return any(str(v).endswith(local_name) for v in record.get_attribute(PROV_TYPE))


def is_namespace_uri(uri):
    """An absolute URI a namespace can be minted under: one with an authority
    (https://example.org/ns/), or a URN with a namespace identifier (RFC 8141)."""
    parsed = urlparse(uri)
    if parsed.scheme.lower() == 'urn':
        return URN.match(uri) is not None
    return bool(parsed.scheme and parsed.netloc)


def check_raw_values(raw_doc):
    """Times, prefixes and qualified-name values, read from the JSON itself."""
    prefixes = raw_doc.get('prefix', {})
    for prefix, uri in prefixes.items():
        if not is_namespace_uri(uri):
            fail(f'prefix {prefix} is not an absolute URI: {uri!r}')
    declared = BUILT_IN_PREFIXES | set(prefixes)
    for record_type, records in raw_doc.items():
        if record_type == 'prefix':
            continue
        for attributes in records.values():
            for key, value in attributes.items():
                if key in TIME_KEYS and parse_xsd_datetime(value) is None:
                    fail(f'{key} {json.dumps(value)} is not an xsd:dateTime')
                for item in value if isinstance(value, list) else [value]:
                    if isinstance(item, dict) and item.get('type') == 'prov:QUALIFIED_NAME':
                        prefix = item['$'].split(':', 1)[0]
                        if prefix not in declared:
                            fail(f'{item["$"]} uses the undeclared prefix {prefix}')


def check_references(records, elements):
    """Every element a relation names is declared, and is the kind PROV-DM requires there."""
    for r in records:
        if not isinstance(r, ProvRelation):
            continue
        kinds = KINDS.get(type(r))
        if kinds is None:
            fail(f'relation {r.get_type()} is not one this validator checks')
        for attr in REQUIRED[type(r)]:
            if not r.get_attribute(attr):
                fail(f'relation {r.get_type()} has no {attr}')
        for attr, kind in kinds.items():
            for value in r.get_attribute(attr):
                if not isinstance(elements.get(value), kind):
                    fail(f'{attr} names {value}, which is not a declared {kind.__name__[4:].lower()}')


def check_disjoint_types(raw_doc):
    """PROV-CONSTRAINTS 55, entity-activity-disjoint, read from the JSON so a duplicate
    identifier cannot be merged away by the parser."""
    both = sorted(set(raw_doc.get('entity', {})) & set(raw_doc.get('activity', {})))
    if both:
        fail(f'{both[0]} is declared as both an entity and an activity (PROV-CONSTRAINTS 55, entity-activity-disjoint)')


def check_derivation_cycles(records):
    """PROV-CONSTRAINTS 42, derivation-generation-generation-ordering: no entity is derived,
    directly or through other derivations, from itself."""
    derived_from = {}
    for r in records:
        if isinstance(r, ProvDerivation):
            for generated in r.get_attribute(PROV_ATTR_GENERATED_ENTITY):
                derived_from.setdefault(generated, []).extend(r.get_attribute(PROV_ATTR_USED_ENTITY))

    finished = set()

    def visit(entity, path):
        if entity in path:
            cycle = path[path.index(entity):] + [entity]
            fail(f'derivation cycle {" <- ".join(map(str, cycle))}: each entity is generated strictly '
                 'before what is derived from it (PROV-CONSTRAINTS 42, derivation-generation-generation-ordering)')
        if entity in finished:
            return
        for used in derived_from.get(entity, []):
            visit(used, path + [entity])
        finished.add(entity)

    for entity in list(derived_from):
        visit(entity, [])


def time_of(record, name):
    """The record's single time attribute, timezone-aware, or None when it is not stated.

    An xsd:dateTime without a timezone is read as UTC, so that two times can always be
    compared; Willder writes every time with one."""
    value = next(iter(record.get_attribute(name)), None)
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


def check_event_times(records, elements):
    """PROV-CONSTRAINTS 30, 33, 34 and 37, checked on the times the document states."""
    def bounds(activity_id):
        activity = elements[activity_id]
        return time_of(activity, PROV_ATTR_STARTTIME), time_of(activity, PROV_ATTR_ENDTIME)

    def within(time, activity_id, what, constraint):
        start, end = bounds(activity_id)
        if time is None:
            return
        if start is not None and time < start:
            fail(f'{what} at {time.isoformat()} precedes the start of {activity_id} ({constraint})')
        if end is not None and time > end:
            fail(f'{what} at {time.isoformat()} follows the end of {activity_id} ({constraint})')

    for r in records:
        if isinstance(r, ProvActivity):
            start, end = time_of(r, PROV_ATTR_STARTTIME), time_of(r, PROV_ATTR_ENDTIME)
            if start is not None and end is not None and start > end:
                fail(f'{r.identifier} ends at {end.isoformat()}, before it starts at {start.isoformat()} '
                     '(PROV-CONSTRAINTS 30, start-precedes-end)')

    generated_at = {}
    for r in records:
        if isinstance(r, ProvGeneration):
            entity, time = next(iter(r.get_attribute(PROV_ATTR_ENTITY))), time_of(r, PROV_ATTR_TIME)
            for activity in r.get_attribute(PROV_ATTR_ACTIVITY):
                within(time, activity, f'the generation of {entity}', 'PROV-CONSTRAINTS 34, generation-within-activity')
            if time is not None:
                generated_at.setdefault(entity, []).append(time)

    for r in records:
        if isinstance(r, ProvUsage):
            activity, time = next(iter(r.get_attribute(PROV_ATTR_ACTIVITY))), time_of(r, PROV_ATTR_TIME)
            within(time, activity, f'a usage by {activity}', 'PROV-CONSTRAINTS 33, usage-within-activity')
            for entity in r.get_attribute(PROV_ATTR_ENTITY):
                for generated in generated_at.get(entity, []):
                    if time is not None and time < generated:
                        fail(f'{activity} uses {entity} at {time.isoformat()}, before it was generated at '
                             f'{generated.isoformat()} (PROV-CONSTRAINTS 37, generation-precedes-usage)')


def main():
    raw = sys.stdin.read()
    raw_doc = json.loads(raw)
    try:
        jsonschema.Draft4Validator(SCHEMA).validate(raw_doc)
    except jsonschema.ValidationError as err:
        fail(f'schema: {err.message} at {list(err.absolute_path)}')
    check_raw_values(raw_doc)
    check_disjoint_types(raw_doc)
    try:
        doc = ProvDocument.deserialize(content=raw, format='json')
    except Exception as err:  # the library raises several unrelated types
        fail(f'prov: {type(err).__name__}: {err}')

    records = doc.get_records()
    elements = {r.identifier: r for r in records if isinstance(r, ProvElement)}
    check_references(records, elements)
    check_derivation_cycles(records)
    check_event_times(records, elements)

    def of(kind):
        return [r for r in records if isinstance(r, kind)]

    def attr(record, name):
        value = record.get_attribute(name)
        return next(iter(value)) if value else None

    def actor(identifier):
        agent = elements[identifier]
        if not isinstance(agent, ProvAgent):
            fail(f'{identifier} is not an agent')
        actor_type = one(agent, 'actorType')
        if actor_type not in ACTOR_TYPES:
            fail(f'{identifier} has willder:actorType {actor_type!r}, expected one of {", ".join(ACTOR_TYPES)}')
        if (actor_type == 'human') != has_type(agent, 'Person'):
            fail(f'{identifier} is willder:actorType {actor_type} but '
                 f'{"is not" if actor_type == "human" else "is"} typed prov:Person')
        return {
            'actorType': actor_type,
            'actorId': one(agent, 'actorId'),
            'name': next(iter(agent.get_attribute('prov:label')), None),
        }

    generations = of(ProvGeneration)
    if len(generations) != 1:
        fail(f'expected one generation, found {len(generations)}')
    version, write = attr(generations[0], PROV_ATTR_ENTITY), attr(generations[0], PROV_ATTR_ACTIVITY)
    if not isinstance(elements.get(version), ProvEntity) or not isinstance(elements.get(write), ProvActivity):
        fail('the generation does not link an entity to an activity')

    attributions = [r for r in of(ProvAttribution) if attr(r, PROV_ATTR_ENTITY) == version]
    if len(attributions) != 1:
        fail(f'expected one attribution of the version, found {len(attributions)}')
    writer_id = attr(attributions[0], PROV_ATTR_AGENT)
    association = next((r for r in of(ProvAssociation)
                        if attr(r, PROV_ATTR_ACTIVITY) == write and attr(r, PROV_ATTR_AGENT) == writer_id), None)
    if association is None:
        fail('the writer is not associated with the write')
    delegations = [r for r in of(ProvDelegation)
                   if attr(r, PROV_ATTR_DELEGATE) == writer_id and attr(r, PROV_ATTR_ACTIVITY) == write]

    derivations = of(ProvDerivation)
    sources = [elements[attr(r, PROV_ATTR_USED_ENTITY)] for r in derivations
               if attr(r, PROV_ATTR_GENERATED_ENTITY) == version and has_type(r, 'PrimarySource')]
    replaces = [one(elements[attr(r, PROV_ATTR_USED_ENTITY)], 'recordId') for r in derivations
                if attr(r, PROV_ATTR_GENERATED_ENTITY) == version and has_type(r, 'Revision')]
    replaced_by = [one(elements[attr(r, PROV_ATTR_GENERATED_ENTITY)], 'recordId') for r in derivations
                   if attr(r, PROV_ATTR_USED_ENTITY) == version and has_type(r, 'Revision')]

    readers = []
    for usage in of(ProvUsage):
        if attr(usage, PROV_ATTR_ENTITY) != version:
            continue
        read = attr(usage, PROV_ATTR_ACTIVITY)
        agents = [attr(r, PROV_ATTR_AGENT) for r in of(ProvAssociation) if attr(r, PROV_ATTR_ACTIVITY) == read]
        if len(agents) != 1:
            fail(f'read {read} has {len(agents)} associated agents, expected one')
        readers.append({'readId': one(elements[read], 'auditRowId'), 'reader': actor(agents[0])})

    print(json.dumps({
        'recordId': one(elements[version], 'recordId'),
        'changeId': one(elements[write], 'changeId'),
        'author': {
            'writer': actor(writer_id),
            'authorizedById': one(association, 'authorizedBy'),
            'authorizationKind': one(association, 'authorizationKind'),
            'authority': actor(attr(delegations[0], PROV_ATTR_RESPONSIBLE)) if delegations else None,
        },
        'source': ({'id': one(sources[0], 'sourceId'),
                    'name': next(iter(sources[0].get_attribute('prov:label'))),
                    'type': one(sources[0], 'sourceType')} if sources else None),
        'readers': sorted(readers, key=lambda r: r['readId']),
        'replaced': {'replacesIds': sorted(replaces), 'replacedById': replaced_by[0] if replaced_by else None},
    }, sort_keys=True))


if __name__ == '__main__':
    main()
