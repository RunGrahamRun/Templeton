# Twinstone CORE compatibility artefacts — controlled baseline

This directory is supporting engineering material; it is **not required to run the browser demo**.

- `CORE_MIGRATION.md` — migration path from the current browser/Worker runtime into Telicent CORE.
- `ies-mapping.json` — controlled class/domain mapping register and identity policy.
- `twinstone-shapes.ttl` — SHACL minimum validation contract for exported Twinstone knowledge.
- `ontology-styles.ttl` — Telicent presentation hints kept separate from ontology semantics.
- `core-record-envelope.schema.json` — candidate JSON envelope schema for the future `knowledge` topic boundary.
- `sample-knowledge.ttl` — small stable-ID RDF example used for parser/contract checks.

Twinstone v1.0.0 is the first controlled Git baseline. It **does not claim full IES4 conformance**; it preserves the mapping/validation foundation established during pre-Git development for a future mapper implemented against the deployed Telicent/IES toolchain.

The controlled baseline retains the context-resource classes, maritime activity extension and their semantic boundaries. Workspace/startup changes and repository automation do not advance or weaken the CORE migration phase.
