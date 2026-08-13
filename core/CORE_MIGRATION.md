# Twinstone → Telicent CORE migration foundation

## Current position

The operational demo remains **static `twinstone.html` + Cloudflare Worker**. No Telicent CORE service, Python mapper, Docker runtime or local server is required to run the demo.

The CORE migration boundary established during pre-Git development is retained in the v1.0.0 controlled baseline:

- IES4 + controlled `tw:` extensions in `../ontology.ttl`.
- Deterministic stable knowledge identities under `https://twinstone.local/id/`.
- Class/domain decisions recorded in `ies-mapping.json`.
- Minimum SHACL constraints in `twinstone-shapes.ttl`.
- Presentation/style metadata separated into `ontology-styles.ttl`.
- Candidate RDF/Turtle export from the browser.
- Candidate CORE envelope deliberately blocked until deployment-approved `Security-Label` and `policyInformation` exist.

## What the controlled baseline means for CORE

Twinstone v1.0.0 is a source-control and assurance baseline, not a claim that the application has moved onto CORE. `coreCompatibility.phase` therefore remains `ies-mapping-foundation`; no Python mapper, Kafka topic or Smart-Cache dependency has been introduced.

New Twinstone concepts must be added to the ontology, mapping register and SHACL artefacts where appropriate, while source observations continue to preserve provenance and deterministic identity. Presentation-only features such as replay remain presentation/query-time views rather than being asserted as new source-world facts.

## Deferred production path

When a suitable engineering environment is available, the intended migration remains:

```mermaid
flowchart LR
  SRC[Source adapters] --> RAW[Raw / normalised records]
  RAW --> MAP[Twinstone IES mapper]
  MAP --> SHACL[SHACL validation]
  SHACL --> RDF[IES4 + tw: RDF]
  RDF --> K[CORE knowledge topic]
  K --> GRAPH[Smart-Cache GRAPH]
  GRAPH --> UI[Twinstone UI]
```

The standalone mapper is **deferred, not abandoned**. It is intentionally not a dependency of the current demo machine.

## Security boundary

Public-source origin does not automatically define an organisational access-control policy. Candidate CORE records remain `readyForPublish: false` until a deployment security policy assigns the required label/policy information.

## Production namespace note

`https://twinstone.local/id/` is a deterministic PoC identity namespace. Before production publication it should move to an organisation-controlled resolvable namespace without changing the identity principles.

## Workspace and context note

The workspace and progressive-startup changes are transport/presentation concerns. Moving IODA, SWPC, ReliefWeb and WHO to a separate `/context` route changes when context is acquired, not its semantic status: context remains separately typed, provenance-bearing and excluded from deterministic corroboration by default.

## Maritime extension

Global Fishing Watch maritime activity is ingested as `tw:MaritimeActivityObservation` with a persistent `ies:Ship` entity where GFW supplies a vessel identity. This is AIS-derived activity history rather than live vessel-position telemetry. A future CORE mapper must preserve GFW event type, source dataset/version, temporal scope, provenance and interpretation caveats. Apparent fishing, encounters, loitering, port visits and AIS gaps must not be promoted into causal, intent or wrongdoing assertions without independent evidence.
