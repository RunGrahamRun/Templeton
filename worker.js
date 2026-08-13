/*
 * Twinstone operational Worker v1.0.0 — first controlled Git baseline
 *
 * Purpose:
 *   - Keep API credentials server-side in Cloudflare Worker secrets.
 *   - Isolate each public feed so one failure cannot take down the others.
 *   - Normalize observations into an IES4-aligned Twinstone envelope.
 *   - Proxy AISStream WebSocket data without exposing the AIS API key.
 *   - Send the fused observation set to Gemini for interrogation.
 *
 * Baseline feeds:
 *   AISStream (real-time vessels)
 *   OpenSky (OAuth2 if configured) -> ADSB.lol fallback (aircraft)
 *   Open-Meteo (weather)
 *   USGS (earthquakes)
 *   NASA FIRMS VIIRS NOAA-20 NRT (thermal anomalies; deterministic clustering)
 *   UCDP Candidate Events (reported/coded organized-violence events; token-gated)
 *   CelesTrak GP/OMM (satellite orbital elements; SGP4 propagation in browser)
 *   IODA Internet Outage Detection (investigation context; non-map)
 *   NOAA SWPC space-weather products (global context; non-map)
 *   ReliefWeb reports (humanitarian context; pre-approved appname required)
 *   WHO Disease Outbreak News (public-health context; non-map)
 *   Global Fishing Watch v3 Events API (AIS-derived maritime activity; token-gated, HTTPS)
 *   Gemini 3.6 Flash (interrogation)
 */

const VERSION = '1.0.0';
const UCDP_API_VERSION = '26.1'; // token-issue guidance supplied with current UCDP access; override with UCDP_API_VERSION Worker variable
const UCDP_LOOKBACK_DAYS = 75;
const GEMINI_MODEL = 'gemini-3.6-flash';
const IES = 'http://ies.data.gov.uk/ontology/ies4#';
const TW = 'https://twinstone.local/ontology#';
const DOVER = { lat: 51.1279, lon: 1.3134 };

let openSkyToken = null;
let openSkyTokenExpiresAt = 0;
let openSkyTokenPromise = null;

let cdseToken = null;
let cdseTokenExpiresAt = 0;
let cdseTokenPromise = null;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname === '/health' && request.method === 'GET') {
        return jsonResponse(healthPayload(env));
      }

      if (url.pathname === '/diagnostics/connectivity' && request.method === 'GET') {
        const bbox = parseBBox(url);
        return jsonResponse(await workerConnectivityDiagnostics(env, bbox));
      }

      if (url.pathname === '/diagnostics/copernicus-imagery' && request.method === 'GET') {
        return jsonResponse(await diagnoseCopernicusImagery(env));
      }

      if (url.pathname === '/ontology' && request.method === 'GET') {
        return jsonResponse(ontologyPayload());
      }

      if (url.pathname === '/snapshot' && request.method === 'GET') {
        const bbox = parseBBox(url);
        return jsonResponse(await buildSnapshot(request, env, bbox));
      }

      if (url.pathname === '/context' && request.method === 'GET') {
        const bbox = parseBBox(url);
        const requestedProfile = String(url.searchParams.get('profile') || 'channel').toLowerCase();
        const profile = ['ukraine','channel','global','investigation'].includes(requestedProfile) ? requestedProfile : 'channel';
        const requestedName = String(url.searchParams.get('areaName') || '').trim().slice(0, 100);
        const areaName = profile === 'ukraine' ? 'Ukraine OSINT profile' : profile === 'global' ? 'Global overview' : profile === 'investigation' ? (requestedName || 'Dynamic investigation AOI') : 'English Channel profile';
        return jsonResponse(await buildInvestigationContext(request, env, bbox, profile, areaName));
      }

      if (url.pathname === '/maritime' && request.method === 'GET') {
        const bbox = parseBBox(url);
        const requestedProfile = String(url.searchParams.get('profile') || 'channel').toLowerCase();
        const profile = ['ukraine','channel','global','investigation'].includes(requestedProfile) ? requestedProfile : 'channel';
        return jsonResponse(await fetchGfwMaritimeActivity(request, env, bbox, profile));
      }

      if (url.pathname === '/satellites/elements' && request.method === 'GET') {
        return jsonResponse(await fetchSatelliteElements(request, ctx));
      }

      if (url.pathname === '/source/copernicus' && request.method === 'GET') {
        const bbox = parseBBox(url);
        return jsonResponse(await fetchCopernicusCatalogue(url, bbox));
      }

      if (url.pathname === '/source/copernicus/image' && request.method === 'POST') {
        return await fetchCopernicusImage(request, env, ctx);
      }

      if (url.pathname === '/query' && request.method === 'POST') {
        return await handleGeminiQuery(request, env);
      }

      if (url.pathname === '/ws/ais') {
        return await handleAISWebSocket(request, env, url);
      }

      return jsonResponse({
        service: 'Twinstone',
        version: VERSION,
        routes: ['/health', '/diagnostics/connectivity', '/diagnostics/copernicus-imagery', '/ontology', '/snapshot', '/context', '/maritime', '/satellites/elements', '/source/copernicus', '/source/copernicus/image', '/query', '/ws/ais'],
      });
    } catch (error) {
      return jsonResponse({
        error: 'Unhandled Worker error',
        detail: safeError(error),
      }, 500);
    }
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function secret(env, ...names) {
  for (const name of names) {
    if (env && typeof env[name] === 'string' && env[name].trim()) return env[name].trim();
  }
  return '';
}

function healthPayload(env) {
  return {
    status: 'ok',
    service: 'Twinstone',
    version: VERSION,
    model: GEMINI_MODEL,
    agent: { provider: 'Google', name: 'Gemini 3.6 Flash', model: GEMINI_MODEL },
    ontology: {
      approach: 'IES4 + Twinstone extension; deterministic identity and SHACL mapping foundation',
      iesNamespace: IES,
      twinstoneNamespace: TW,
      coreCompatibility: { target: 'Telicent CORE', phase: 'ies-mapping-foundation', ontologyTopic: 'ontology', knowledgeTopic: 'knowledge', rdfContentType: 'text/turtle', securityPolicy: 'deployment-required' },
    },
    coreCompatibility: {
      target: 'Telicent CORE',
      phase: 'ies-mapping-foundation',
      runtime: 'Cloudflare Worker + browser remains active',
      identityPolicy: 'deterministic-v1',
      identityNamespace: 'https://twinstone.local/id/',
      mappingRegister: 'core/ies-mapping.json',
      shaclContract: 'core/twinstone-shapes.ttl',
      plannedPipeline: ['adapter', 'validation mapper', 'normalisation mapper', 'deterministic derivation mapper', 'IES4/RDF mapper', 'SHACL validation', 'knowledge'],
      topics: { ontology: 'ontology', knowledge: 'knowledge' },
      security: 'Security-Label and policyInformation must be assigned by deployment policy before publication',
    },
    secrets: {
      gemini: Boolean(secret(env, 'GEMINI_API_KEY', 'GOOGLE_API_KEY')),
      aisstream: Boolean(secret(env, 'AISSTREAM_API_KEY', 'AIS_API_KEY')),
      openskyOAuth: Boolean(secret(env, 'OPENSKY_CLIENT_ID') && secret(env, 'OPENSKY_CLIENT_SECRET')),
      aishub: Boolean(secret(env, 'AISHUB_USERNAME')),
      globalFishingWatch: Boolean(secret(env, 'GFW_API_TOKEN')),
      adsbExchange: Boolean(secret(env, 'ADSBEXCHANGE_API_KEY')),
      firms: Boolean(secret(env, 'FIRMS_MAP_KEY')),
      acled: Boolean(secret(env, 'ACLED_ACCESS_TOKEN')),
      ucdp: Boolean(secret(env, 'UCDP_ACCESS_TOKEN')),
      copernicusImagery: Boolean(cdseClientId(env) && cdseClientSecret(env)),
      reliefWebAppname: Boolean(secret(env, 'RELIEFWEB_APPNAME')),
    },
    feeds: {
      celestrak: { configured: true, credentialsRequired: false, operationalRoute: 'browser-https preferred; Worker cached fallback', group: 'visual', freshCacheSeconds: 7200, staleFallbackSeconds: 86400 },
      copernicus: { configured: true, credentialsRequired: false, operationalRoute: 'browser-https STAC catalogue; Worker fallback; Process API image rendering when OAuth configured', collections: ['sentinel-1-grd', 'sentinel-2-l2a'], processImageryConfigured: Boolean(cdseClientId(env) && cdseClientSecret(env)) },
      aircraft: { strategy: 'non-critical', operationalProvider: 'ADSB.lol reusable regional acquisition cells', cacheGridDegrees: 1, freshCacheSeconds: 300, staleFallbackSeconds: 3600, investigationProfile: 'enabled', channelProfile: 'enabled', ukraineProfile: 'not queried', openSky: 'bounded anonymous cold-start fallback only; OAuth remains diagnostic because Worker auth is unreliable in the qualified environment' },
      weather: { provider: 'Open-Meteo', operationalRoute: 'worker-https' },
      earthquakes: { provider: 'USGS', operationalRoute: 'worker-https' },
      firms: { provider: 'NASA FIRMS VIIRS NOAA-20 NRT', operationalRoute: 'worker-https', credentialsRequired: true, configured: Boolean(secret(env, 'FIRMS_MAP_KEY')), productSemantics: 'active fire / thermal anomaly detections; cause is not established', clustering: '1.5 km / 90 min deterministic connected components; low-confidence pixels filtered from operational clusters' },
      ucdp: { provider: 'UCDP Candidate Events', operationalRoute: 'worker-https', credentialsRequired: true, configured: Boolean(secret(env, 'UCDP_ACCESS_TOKEN')), apiVersion: secret(env, 'UCDP_API_VERSION') || UCDP_API_VERSION, lookbackDays: UCDP_LOOKBACK_DAYS, productSemantics: 'reported/coded organized-violence events; not a physical sensor observation and not causal evidence for co-located sensor anomalies' },
      ioda: { provider: 'Georgia Tech IODA v2', operationalRoute: 'worker-https', credentialsRequired: false, role: 'investigation context', mapRole: 'non-map context plane', semantics: 'internet outage events are connectivity evidence/context, not proof of cause or physical disruption' },
      swpc: { provider: 'NOAA Space Weather Prediction Center', operationalRoute: 'worker-https', credentialsRequired: false, role: 'global investigation context', mapRole: 'none', semantics: 'space-environment context; relevance does not establish cause of local system anomalies' },
      reliefweb: { provider: 'OCHA ReliefWeb API v2', operationalRoute: 'worker-https', credentialsRequired: true, configured: Boolean(secret(env, 'RELIEFWEB_APPNAME')), credentialName: 'RELIEFWEB_APPNAME', role: 'humanitarian reported-information context' },
      who: { provider: 'WHO Disease Outbreak News', operationalRoute: 'worker-https', credentialsRequired: false, role: 'public-health reported-information context', mapRole: 'none' },
      globalFishingWatch: { provider: 'Global Fishing Watch v3 Events API', operationalRoute: 'worker-https background enrichment via /maritime', credentialsRequired: true, configured: Boolean(secret(env, 'GFW_API_TOKEN')), role: 'AIS-derived maritime activity intelligence', mapRole: 'optional event markers; not live vessel positions', semantics: 'apparent fishing, encounter, loitering, port-visit and AIS-gap events are algorithmic AIS-derived records; source caveats are retained and Twinstone does not infer intent, transshipment, confirmed fishing or deliberate AIS disabling from the event alone' },
    },
    qualifiedCandidates: {
      firms: 'operational in Ukraine profile when FIRMS_MAP_KEY is configured',
      acled: 'reachable; ACLED_ACCESS_TOKEN required',
      ucdp: 'operational in Ukraine profile when UCDP_ACCESS_TOKEN is configured; adapter is ready while token is pending',
      aishub: 'REST reachable; AISHUB_USERNAME required',
      globalFishingWatch: 'operational /maritime adapter when GFW_API_TOKEN is configured; Events API remains separate from live vessel-position feeds',
      adsbExchange: 'gateway reachable; ADSBEXCHANGE_API_KEY/licence required',
      ukSanctions: 'worker-https qualified',
      gdelt: 'not on critical path because connectivity is inconsistent',
      aisstream: 'not on critical path; WebSocket transport excluded for demo environment',
      reliefweb: 'adapter active when RELIEFWEB_APPNAME contains a pre-approved ReliefWeb appname',
      ioda: 'context adapter uses the official IODA v2 outage events endpoint',
      swpc: 'context adapter uses NOAA SWPC JSON products',
      who: 'context adapter uses WHO Disease Outbreak News REST/OData endpoint',
    },
    resilience: { agentTransientRetries: 4, retryStrategy: 'client-visible exponential backoff with jitter', browserFirstCelesTrak: true, browserFirstCopernicus: true, aircraftWorkerCache: true, aircraftReusableRegionalCache: true, aircraftAdaptiveBackoff: true, aircraftColdStartFallback: 'OpenSky anonymous, bounded timeout', contextFeedsIsolated: true, contextOffCriticalPath: true, contextCache: true, contextNeverRaisesCorroborationScore: true, maritimeOffCriticalPath: true, maritimeCacheSeconds: 1800, maritimeStaleFallbackSeconds: 86400 },
    diagnostics: { endpoint: '/diagnostics/connectivity', copernicusImageryEndpoint: '/diagnostics/copernicus-imagery', contextEndpoint: '/context', maritimeEndpoint: '/maritime', purpose: 'Retained qualification endpoint, safe Copernicus OAuth verification, background context acquisition and credential-gated GFW maritime activity.' },
    note: 'Secret values are never returned to the browser.',
  };
}

function ontologyPayload() {
  return {
    namespaces: {
      ies: IES,
      tw: TW,
      prov: 'http://www.w3.org/ns/prov#',
    },
    identity: {
      namespace: 'https://twinstone.local/id/',
      policy: 'deterministic-v1',
      runtimeIds: 'retained as tw:runtimeId trace literals in exported RDF',
    },
    validation: {
      mappingRegister: 'core/ies-mapping.json',
      shaclContract: 'core/twinstone-shapes.ttl',
      scope: 'minimum Twinstone export-boundary contract; not a claim of complete IES4 conformance',
    },
    classes: {
      ship: `${IES}Ship`,
      observationEvent: `${TW}ObservationEvent`,
      vesselPositionObservation: `${TW}VesselPositionObservation`,
      maritimeActivityObservation: `${TW}MaritimeActivityObservation`,
      aircraft: `${TW}Aircraft`,
      aircraftPositionObservation: `${TW}AircraftPositionObservation`,
      satellite: `${TW}Satellite`,
      satellitePositionEstimate: `${TW}SatellitePositionEstimate`,
      weatherObservation: `${TW}WeatherObservationEvent`,
      earthquakeEvent: `${TW}EarthquakeEvent`,
      earthObservationAcquisition: `${TW}EarthObservationAcquisition`,
      earthObservationProduct: `${TW}EarthObservationProduct`,
      thermalAnomalyObservation: `${TW}ThermalAnomalyObservation`,
      thermalAnomalyCluster: `${TW}ThermalAnomalyCluster`,
      crossSourceAssociation: `${TW}CrossSourceAssociation`,
      reportedConflictEvent: `${TW}ReportedConflictEvent`,
      multiSourceEvidenceChain: `${TW}MultiSourceEvidenceChain`,
      corroborationAreaObservation: `${TW}CorroborationAreaObservation`,
      corroborationArea: `${TW}CorroborationArea`,
    },
    note: `Twinstone v${VERSION} is the first controlled Git baseline. It retains credential-gated Global Fishing Watch AIS-derived maritime activity through the separate background /maritime route, does not claim live vessel positions, and preserves event-specific caveats.`,
  };
}

function parseBBox(url) {
  const south = clampNumber(url.searchParams.get('south'), -90, 90, 49.4);
  const west  = clampNumber(url.searchParams.get('west'), -180, 180, -5.8);
  const north = clampNumber(url.searchParams.get('north'), -90, 90, 52.2);
  const east  = clampNumber(url.searchParams.get('east'), -180, 180, 3.0);

  if (south >= north || west >= east) {
    return { south: 49.4, west: -5.8, north: 52.2, east: 3.0 };
  }
  return { south, west, north, east };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function bboxCenter(bbox) {
  return {
    lat: (bbox.south + bbox.north) / 2,
    lon: (bbox.west + bbox.east) / 2,
  };
}

function inBBox(lat, lon, bbox) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function makeObservation({
  source,
  observationType,
  entityId,
  entityType,
  observedAt,
  lat,
  lon,
  label,
  kinematics = {},
  attributes = {},
  sourceRecordId = '',
}) {
  const time = observedAt || new Date().toISOString();
  const obsIdSeed = encodeURIComponent(`${source}:${entityId}:${time}`);
  const location = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;

  return {
    '@id': `urn:twinstone:observation:${obsIdSeed}`,
    '@type': observationType,
    entity: {
      '@id': entityId,
      '@type': entityType,
      label: label || entityId,
    },
    observedAt: time,
    location,
    kinematics,
    attributes,
    derived: location ? {
      distanceToDoverKm: Number(haversineKm(lat, lon, DOVER.lat, DOVER.lon).toFixed(2)),
    } : {},
    provenance: {
      source,
      sourceRecordId: sourceRecordId || entityId,
      ingestedAt: new Date().toISOString(),
      transport: 'worker-https',
    },
  };
}

async function buildSnapshot(request, env, bbox) {
  const url = new URL(request.url);
  const requestedProfile = String(url.searchParams.get('profile') || 'channel').toLowerCase();
  const profile = ['ukraine','channel','global','investigation'].includes(requestedProfile) ? requestedProfile : 'channel';
  const requestedName = String(url.searchParams.get('areaName') || '').trim().slice(0, 100);
  const areaName = profile === 'ukraine' ? 'Ukraine OSINT profile' : profile === 'global' ? 'Global overview' : profile === 'investigation' ? (requestedName || 'Dynamic investigation AOI') : 'English Channel profile';
  const feeds = [
    { name: 'earthquakes', run: () => fetchEarthquakes(bbox, profile === 'global') },
  ];
  if (profile !== 'global') feeds.unshift({ name: 'weather', run: () => fetchWeather(bbox, areaName, profile) });

  // FIRMS is operational in the Ukraine profile when FIRMS_MAP_KEY is present.
  // Twinstone requests one day of VIIRS NOAA-20 NRT detections, filters low-
  // confidence pixels from the operational picture, clusters the remaining
  // detections deterministically, and returns cluster observations rather than
  // flooding the map/agent with every 375 m hotspot pixel.
  if (profile === 'ukraine' || profile === 'investigation') {
    feeds.push({ name: 'thermal', run: () => fetchFirmsThermal(request, env, bbox) });
    // UCDP remains non-blocking while the access token is pending. Once
    // UCDP_ACCESS_TOKEN is added, the same build begins ingesting versioned
    // Candidate GED events without exposing the token to the browser.
    feeds.push({ name: 'reportedConflict', run: () => fetchUcdpReportedEvents(request, env, bbox) });
  }

  // Aircraft is deliberately non-critical in the Ukraine profile. Our source
  // qualification showed that OpenSky is CORS-blocked in-browser and the
  // Worker OAuth path times out, while ADSB.lol can be rate limited. Avoid
  // stalling the Ukraine operational picture on an unreliable aircraft route.
  if (profile === 'channel' || profile === 'investigation') {
    feeds.unshift({ name: 'aircraft', run: () => fetchAircraftOperational(request, env, bbox) });
  }

  // Controlled baseline retains the pre-Git /context split so non-critical OSINT reporting never delays the core map snapshot.
  const settled = await Promise.allSettled(feeds.map(feed => feed.run()));
  const health = {};
  const observations = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const configuredName = feeds[i].name;
    if (result.status === 'fulfilled') {
      const feed = result.value;
      health[feed.feed || configuredName] = {
        status: feed.status,
        provider: feed.provider,
        count: feed.observations.length,
        error: feed.error || null,
        cacheState: feed.cacheState || null,
        upstreamStatus: feed.upstreamStatus || null,
        sourceDataFetchedAt: feed.sourceDataFetchedAt || null,
        lastSuccessfulSnapshotAt: feed.lastSuccessfulSnapshotAt || feed.sourceDataFetchedAt || null,
        nextUpstreamAttemptAt: feed.nextUpstreamAttemptAt || null,
        lastUpstreamAttemptAt: feed.lastUpstreamAttemptAt || null,
        providerPool: feed.providerPool || null,
        acquisitionRegion: feed.acquisitionRegion || null,
        transport: feed.transport || 'worker-https',
        metrics: feed.metrics || null,
        policy: feed.policy || null,
      };
      observations.push(...feed.observations);
    } else {
      health[configuredName] = { status: 'error', provider: null, error: safeError(result.reason), count: 0, transport: 'worker-https', metrics: null, policy: null };
    }
  }

  if (profile === 'ukraine') {
    health.aircraft = {
      status: 'not-used', provider: 'none', count: 0,
      error: 'Aircraft is excluded from the Ukraine critical path because no qualified reliable route is currently available.', transport: null,
    };
  } else if (profile === 'global') {
    health.aircraft = { status: 'not-used', provider: 'none', count: 0, error: 'Global aircraft ingestion is intentionally disabled; available aircraft providers are regional/rate-limited.', transport: null };
    health.weather = { status: 'not-used', provider: 'Open-Meteo', count: 0, error: 'Point weather is not meaningful for a world-scale overview. Switch to a regional profile.', transport: null };
    health.thermal = { status: 'not-used', provider: 'NASA FIRMS VIIRS NOAA-20 NRT', count: 0, error: 'World-scale FIRMS ingestion is intentionally disabled. Use a regional profile to avoid excessive and misleading global hotspot volume.', transport: null, metrics: null, policy: null };
    health.reportedConflict = { status: 'not-used', provider: 'UCDP Candidate Events', count: 0, error: 'World-scale UCDP ingestion is intentionally disabled in Global overview. Use a regional profile for deterministic fusion.', transport: null, metrics: null, policy: null };
  } else if (profile === 'channel') {
    health.thermal = { status: 'not-used', provider: 'NASA FIRMS VIIRS NOAA-20 NRT', count: 0, error: 'Thermal-anomaly ingestion is enabled for Ukraine and bounded Investigation AOIs in this build.', transport: null, metrics: null, policy: null };
    health.reportedConflict = { status: 'not-used', provider: 'UCDP Candidate Events', count: 0, error: 'UCDP reported-event ingestion is enabled for Ukraine and bounded Investigation AOIs in this build.', transport: null, metrics: null, policy: null };
  }


  return {
    service: 'Twinstone',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    area: { name: areaName, profile, bbox },
    sourcePolicy: {
      workerCriticalPath: profile === 'ukraine' ? ['Open-Meteo', 'USGS', 'NASA FIRMS', 'Gemini'] : profile === 'investigation' ? ['Open-Meteo', 'USGS', 'NASA FIRMS', 'UCDP when configured', 'Gemini'] : profile === 'global' ? ['USGS', 'Gemini'] : ['Open-Meteo', 'USGS', 'Gemini'],
      browserPreferred: profile === 'global' ? ['CelesTrak on demand'] : ['CelesTrak', 'Copernicus STAC'],
      nonCritical: profile === 'investigation' ? ['ADSB.lol regional-cell aircraft', 'OpenSky anonymous cold-start fallback', 'GDELT', 'AISStream'] : ['ADSB.lol regional-cell aircraft', 'OpenSky anonymous cold-start fallback', 'GDELT', 'AISStream'],
      backgroundContext: ['IODA', 'NOAA SWPC', 'ReliefWeb when configured', 'WHO DON'],
      backgroundMaritime: ['Global Fishing Watch Events API when GFW_API_TOKEN is configured'],
    },
    health,
    observations,
  };
}


function gfwBboxGeometry(bbox) {
  return {
    type: 'Polygon',
    coordinates: [[
      [bbox.west, bbox.south],
      [bbox.east, bbox.south],
      [bbox.east, bbox.north],
      [bbox.west, bbox.north],
      [bbox.west, bbox.south],
    ]],
  };
}

function gfwDatasetForType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'fishing') return 'public-global-fishing-events:latest';
  if (t === 'encounter') return 'public-global-encounters-events:latest';
  if (t === 'loitering') return 'public-global-loitering-events:latest';
  if (t === 'port_visit' || t === 'port') return 'public-global-port-visits-events:latest';
  if (t === 'gap') return 'public-global-gaps-events:latest';
  return null;
}

function gfwActivityLabel(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'fishing') return 'Apparent fishing event';
  if (t === 'encounter') return 'Vessel encounter event';
  if (t === 'loitering') return 'Loitering event';
  if (t === 'port_visit' || t === 'port') return 'Port visit event';
  if (t === 'gap') return 'AIS gap event';
  return 'Maritime activity event';
}

function gfwInterpretationBoundary(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'fishing') return 'Global Fishing Watch apparent-fishing event derived from AIS movement patterns. Twinstone does not treat it as independently confirmed fishing activity.';
  if (t === 'encounter') return 'Global Fishing Watch AIS-derived encounter indicator. A vessel encounter may have multiple explanations and does not by itself establish transshipment, transfer, intent or wrongdoing.';
  if (t === 'loitering') return 'Global Fishing Watch AIS-derived loitering behaviour. Loitering does not by itself establish an encounter, transshipment, intent or wrongdoing.';
  if (t === 'port_visit' || t === 'port') return 'Global Fishing Watch AIS-derived port-visit event. Source confidence is retained where supplied; Twinstone does not treat it as direct port-authority confirmation.';
  if (t === 'gap') return 'Global Fishing Watch AIS-gap event. The gaps dataset is prototype-quality; Twinstone does not independently establish deliberate AIS disabling, cause, intent or activity during the gap.';
  return 'Global Fishing Watch AIS-derived maritime activity record. Source classification is retained without adding causal or intent inference.';
}

function gfwEventObservation(entry) {
  const vessel = entry?.vessel || {};
  const lat = Number(entry?.position?.lat), lon = Number(entry?.position?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const type = String(entry?.type || '').toLowerCase();
  const sourceRecordId = String(entry?.id || '').trim();
  if (!sourceRecordId) return null;
  const gfwVesselId = String(vessel?.id || '').trim();
  const mmsi = String(vessel?.ssvid || '').trim();
  const vesselKey = gfwVesselId || mmsi || sourceRecordId;
  const startAt = entry?.start ? new Date(entry.start).toISOString() : null;
  const endAt = entry?.end ? new Date(entry.end).toISOString() : null;
  const detail = type === 'fishing' ? entry?.fishing : type === 'encounter' ? entry?.encounter : type === 'loitering' ? entry?.loitering : (type === 'port_visit' || type === 'port') ? entry?.port_visit : type === 'gap' ? entry?.gap : null;
  const encountered = type === 'encounter' ? detail?.vessel || null : null;
  const dataset = gfwDatasetForType(type);
  const observation = makeObservation({
    source: 'Global Fishing Watch Events API',
    observationType: `${TW}MaritimeActivityObservation`,
    entityId: `urn:twinstone:ship:gfw:${encodeURIComponent(vesselKey)}`,
    entityType: `${IES}Ship`,
    observedAt: startAt || endAt || new Date().toISOString(),
    lat,
    lon,
    label: `${gfwActivityLabel(type)} · ${String(vessel?.name || mmsi || gfwVesselId || 'vessel')}`,
    sourceRecordId,
    attributes: {
      maritimeActivityType: type ? type.toUpperCase() : 'UNKNOWN',
      activityStartAt: startAt,
      activityEndAt: endAt,
      dataset,
      gfwVesselId: gfwVesselId || null,
      mmsi: mmsi || null,
      vesselName: vessel?.name || null,
      vesselType: vessel?.type || null,
      flag: vessel?.flag || null,
      algorithmicNature: 'AIS-derived event produced by Global Fishing Watch',
      interpretation: gfwInterpretationBoundary(type),
      sourcePotentialRisk: detail?.potentialRisk ?? null,
      eventDetail: detail || null,
      encounteredVessel: encountered ? {
        gfwVesselId: encountered.id || null,
        mmsi: encountered.ssvid || null,
        name: encountered.name || null,
        flag: encountered.flag || null,
        type: encountered.type || null,
      } : null,
      portVisitConfidence: (type === 'port_visit' || type === 'port') ? (detail?.confidence ?? entry?.confidence ?? null) : null,
      regions: entry?.regions || null,
      sourceBoundingBox: Array.isArray(entry?.boundingBox) ? entry.boundingBox : null,
      distances: entry?.distances || null,
      cause: 'unknown',
      intent: 'unknown',
    },
  });
  observation.provenance.method = 'Global Fishing Watch v3 Events API; AIS-derived algorithmic maritime activity';
  observation.provenance.sourceUrl = 'https://gateway.api.globalfishingwatch.org/v3/events';
  return observation;
}

async function fetchGfwMaritimeActivity(request, env, bbox, profile) {
  const token = secret(env, 'GFW_API_TOKEN');
  const basePolicy = {
    endpoint: 'https://gateway.api.globalfishingwatch.org/v3/events',
    datasets: [
      'public-global-fishing-events:latest',
      'public-global-encounters-events:latest',
      'public-global-loitering-events:latest',
      'public-global-port-visits-events:latest',
      'public-global-gaps-events:latest',
    ],
    outputCap: 200,
    minimumSourceAwareLookbackHours: 168,
    mapRole: 'AIS-derived activity events; not live vessel positions',
    gapCaveat: 'GFW gaps dataset is prototype-quality; Twinstone does not independently establish deliberate AIS disabling, cause or intent.',
    usagePolicy: 'Provider documentation states GFW APIs are for non-commercial purposes and requires compliance with its terms/attribution; deployment suitability must be confirmed by the operator.',
  };
  if (profile === 'global') return {
    feed: 'maritimeActivity', provider: 'Global Fishing Watch v3 Events API', status: 'not-used', observations: [],
    error: 'World-scale GFW event ingestion is intentionally disabled. Pick a bounded Investigation AOI or regional profile.', transport: 'worker-https', metrics: { returnedEvents: 0 }, policy: basePolicy,
  };
  if (!token) return {
    feed: 'maritimeActivity', provider: 'Global Fishing Watch v3 Events API', status: 'credential-required', observations: [],
    error: 'GFW_API_TOKEN is not configured. The HTTPS maritime activity adapter will activate after the bearer token is added to the Worker.', transport: 'worker-https', metrics: { returnedEvents: 0 }, policy: basePolicy,
  };

  const url = new URL(request.url);
  const selectedHours = Math.min(720, Math.max(1, Number(url.searchParams.get('windowHours') || 24)));
  const retrievalHours = Math.max(basePolicy.minimumSourceAwareLookbackHours, selectedHours);
  const now = new Date();
  const start = new Date(now.getTime() - retrievalHours * 3600000);
  const endExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const startDate = start.toISOString().slice(0, 10), endDate = endExclusive.toISOString().slice(0, 10);
  const sig = [bbox.south,bbox.west,bbox.north,bbox.east].map(v=>Number(v).toFixed(2)).join('_');
  const cache = caches.default, origin = url.origin;
  const freshKey = new Request(`${origin}/__twinstone_cache/gfw-events-v1/${sig}/${startDate}/${endDate}/fresh`);
  const staleKey = new Request(`${origin}/__twinstone_cache/gfw-events-v1/${sig}/${startDate}/${endDate}/stale`);
  const cached = await readJsonCache(cache, freshKey);
  if (cached?.observations) return { ...cached, status: 'cached', cacheState: 'fresh-cache', servedAt: new Date().toISOString() };
  const stale = await readJsonCache(cache, staleKey);

  const endpoint = 'https://gateway.api.globalfishingwatch.org/v3/events?offset=0&limit=200&sort=-start';
  const body = { datasets: basePolicy.datasets, startDate, endDate, geometry: gfwBboxGeometry(bbox) };
  try {
    const r = await safeFetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': `Twinstone/${VERSION} GFW` },
      body: JSON.stringify(body),
    }, 20_000);
    const text = await r.text();
    if (!r.ok) { const e = new Error(`Global Fishing Watch HTTP ${r.status}: ${text.slice(0,240)}`); e.status = r.status; throw e; }
    const data = JSON.parse(text);
    const raw = Array.isArray(data?.entries) ? data.entries : [];
    const seen = new Set(), observations = [];
    for (const entry of raw) {
      const id = String(entry?.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const o = gfwEventObservation(entry);
      if (!o || !inBBox(o.location.lat, o.location.lon, bbox)) continue;
      observations.push(o);
    }
    const byType = {};
    for (const o of observations) { const k=String(o.attributes?.maritimeActivityType||'UNKNOWN'); byType[k]=(byType[k]||0)+1; }
    const payload = {
      feed: 'maritimeActivity', provider: 'Global Fishing Watch v3 Events API', status: 'live', observations, error: null,
      cacheState: 'origin', upstreamStatus: 'live', sourceDataFetchedAt: new Date().toISOString(), lastSuccessfulSnapshotAt: new Date().toISOString(), transport: 'worker-https',
      metrics: { totalMatches: Number(data?.total ?? raw.length), returnedEvents: observations.length, byType, truncated: Number(data?.total||0) > raw.length, datasetVersions: r.headers.get('x-datasets') || data?.metadata?.datasets || null, retrievalHours, selectedAnalysisWindowHours: selectedHours },
      policy: { ...basePolicy, retrievalHours, selectedAnalysisWindowHours: selectedHours, dateRange: { startDate, endDate }, note: 'A minimum seven-day retrieval window is used because GFW is an AIS-derived activity-history source rather than live vessel telemetry. Event timestamps remain source timestamps.' },
    };
    await putJsonCache(cache, freshKey, payload, 30*60);
    await putJsonCache(cache, staleKey, payload, 24*60*60);
    return payload;
  } catch (error) {
    if (stale?.observations?.length) return { ...stale, status: 'fallback', cacheState: 'stale-cache', upstreamStatus: 'degraded', error: `Global Fishing Watch ${safeError(error)}`, servedAt: new Date().toISOString() };
    return { feed: 'maritimeActivity', provider: 'Global Fishing Watch v3 Events API', status: 'degraded', observations: [], error: safeError(error), transport: 'worker-https', metrics: { returnedEvents: 0, retrievalHours, selectedAnalysisWindowHours: selectedHours }, policy: { ...basePolicy, retrievalHours, selectedAnalysisWindowHours: selectedHours } };
  }
}


function cleanContextText(value, max = 900) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function contextStatus(provider, status, items = [], extra = {}) {
  return {
    provider,
    status,
    count: Array.isArray(items) ? items.length : 0,
    items: Array.isArray(items) ? items : [],
    fetchedAt: new Date().toISOString(),
    role: 'investigation-context',
    contributesToCorroborationScore: false,
    ...extra,
  };
}

async function resolveInvestigationPlace(request, bbox, profile, areaName) {
  if (profile === 'global') return { status: 'global', country: null, countryCode: null, displayName: 'Global', source: null, attribution: null };
  if (profile === 'ukraine') return { status: 'preset', country: 'Ukraine', countryCode: 'UA', displayName: 'Ukraine', source: 'Twinstone profile preset', attribution: null };

  const c = bboxCenter(bbox);
  const cache = caches.default;
  const origin = new URL(request.url).origin;
  // Roughly 1 km cache buckets stop polling from repeatedly calling the public
  // Nominatim service. Reverse geocoding is only a scope helper, never evidence.
  const latKey = Number(c.lat).toFixed(2), lonKey = Number(c.lon).toFixed(2);
  const key = new Request(`${origin}/__twinstone_cache/context-place/${latKey}/${lonKey}`);
  const cached = await readJsonCache(cache, key);
  if (cached) return { ...cached, cacheState: 'cached' };

  // OSMF public Nominatim policy requires an absolute maximum of one request
  // per second. A shared short cache lock plus long-lived result cache keeps
  // Twinstone comfortably below that in the single-user PoC/demo workflow.
  const rateKey = new Request(`${origin}/__twinstone_cache/nominatim-rate-lock`);
  const rateLock = await readJsonCache(cache, rateKey);
  if (rateLock) return { status: 'rate-limited', country: null, countryCode: null, displayName: areaName || null, source: 'OpenStreetMap Nominatim reverse geocoding', error: 'Context country resolution deferred to respect the public Nominatim rate limit.', caveat: 'Country-scoped context will retry on the next background context refresh.' };
  await putJsonCache(cache, rateKey, { setAt: new Date().toISOString() }, 2);

  const u = new URL('https://nominatim.openstreetmap.org/reverse');
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('lat', c.lat.toFixed(6));
  u.searchParams.set('lon', c.lon.toFixed(6));
  u.searchParams.set('zoom', '3');
  u.searchParams.set('addressdetails', '1');
  try {
    const r = await safeFetch(u.toString(), { headers: { 'Accept': 'application/json', 'Accept-Language': 'en', 'User-Agent': `Twinstone/${VERSION} investigation-scope` } }, 7000);
    if (!r.ok) throw new Error(`Nominatim HTTP ${r.status}`);
    const d = await r.json();
    const country = cleanContextText(d?.address?.country || '', 120) || null;
    const countryCode = String(d?.address?.country_code || '').toUpperCase() || null;
    const payload = {
      status: countryCode ? 'resolved' : 'unresolved',
      country, countryCode,
      state: cleanContextText(d?.address?.state || '', 120) || null,
      displayName: cleanContextText(d?.display_name || areaName || '', 220) || null,
      source: 'OpenStreetMap Nominatim reverse geocoding',
      attribution: '© OpenStreetMap contributors, ODbL',
      caveat: 'Nearest indexed OSM object used only to scope country-level context; it is not source evidence and may occasionally resolve unexpectedly.',
      resolvedAt: new Date().toISOString(),
    };
    await putJsonCache(cache, key, payload, 7 * 24 * 60 * 60);
    return payload;
  } catch (error) {
    return { status: 'degraded', country: null, countryCode: null, displayName: areaName || null, source: 'OpenStreetMap Nominatim reverse geocoding', error: safeError(error), caveat: 'Country resolution unavailable; country-scoped context sources may be omitted.' };
  }
}

function contextCacheRequest(request, family, signature) {
  const origin = new URL(request.url).origin;
  return new Request(`${origin}/__twinstone_cache/context/${family}/${encodeURIComponent(signature)}`);
}

async function fetchIodaContext(request, place, windowHours) {
  const from = Math.floor((Date.now() - Math.min(720, Math.max(1, Number(windowHours) || 24)) * 3600000) / 1000);
  const until = Math.floor(Date.now() / 1000);
  const countryCode = place?.countryCode || null;
  const cache = caches.default;
  const sig = `${countryCode || 'global'}-${Math.min(720, Math.max(1, Number(windowHours) || 24))}`;
  const key = contextCacheRequest(request, 'ioda-v2', sig);
  const cached = await readJsonCache(cache, key);
  if (cached) return { ...cached, cacheState: 'fresh-cache' };
  const u = new URL('https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events');
  u.searchParams.set('from', String(from));
  u.searchParams.set('until', String(until));
  u.searchParams.set('entityType', 'country');
  if (countryCode) u.searchParams.set('entityCode', countryCode);
  u.searchParams.set('format', 'ioda');
  u.searchParams.set('limit', countryCode ? '20' : '12');
  u.searchParams.set('orderBy', 'time/desc');
  try {
    const r = await safeFetch(u.toString(), { headers: { 'Accept': 'application/json', 'User-Agent': `Twinstone/${VERSION}` } }, 10000);
    if (!r.ok) throw new Error(`IODA HTTP ${r.status}`);
    const d = await r.json();
    const raw = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : Array.isArray(d?.data?.events) ? d.data.events : Array.isArray(d?.results) ? d.results : [];
    const items = raw.slice(0, countryCode ? 20 : 12).map((x, i) => {
      const st = Number(x?.from ?? x?.start), en = Number(x?.until ?? (Number(x?.start) + Number(x?.duration || 0)));
      const code = String(x?.entityCode || String(x?.location || '').split('/').pop() || countryCode || '').toUpperCase();
      return {
        id: `ioda-${code || 'global'}-${Number.isFinite(st) ? st : i}-${x?.datasource || 'combined'}`,
        title: `Internet outage event${x?.location_name ? ` — ${cleanContextText(x.location_name, 100)}` : code ? ` — ${code}` : ''}`,
        entityType: x?.entityType || 'country', entityCode: code || null,
        datasource: x?.datasource || null,
        startAt: Number.isFinite(st) ? new Date(st * 1000).toISOString() : null,
        endAt: Number.isFinite(en) ? new Date(en * 1000).toISOString() : null,
        score: Number.isFinite(Number(x?.score)) ? Number(x.score) : null,
        sourceUrl: 'https://ioda.inetintel.cc.gatech.edu/',
        epistemicBoundary: 'IODA connectivity/outage event; it does not establish why connectivity changed or that a physical incident occurred.',
      };
    });
    const payload = contextStatus('Georgia Tech IODA v2', 'live', items, { scope: countryCode ? 'country' : 'global', countryCode, country: place?.country || null, windowHours: Math.min(720, Math.max(1, Number(windowHours) || 24)), transport: 'worker-https', sourceUrl: u.toString(), caveat: 'Connectivity context only. Twinstone does not infer cause from an IODA outage event.' });
    await putJsonCache(cache, key, payload, 10 * 60);
    return payload;
  } catch (error) {
    return contextStatus('Georgia Tech IODA v2', 'degraded', [], { scope: countryCode ? 'country' : 'global', countryCode, country: place?.country || null, error: safeError(error), transport: 'worker-https' });
  }
}

async function fetchSwpcContext(request) {
  const cache = caches.default;
  const key = contextCacheRequest(request, 'swpc-v1', 'global');
  const cached = await readJsonCache(cache, key);
  if (cached) return { ...cached, cacheState: 'fresh-cache' };
  try {
    const [kpR, alertsR, scalesR] = await Promise.all([
      safeFetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', { headers: { 'Accept': 'application/json', 'User-Agent': `Twinstone/${VERSION}` } }, 9000),
      safeFetch('https://services.swpc.noaa.gov/products/alerts.json', { headers: { 'Accept': 'application/json', 'User-Agent': `Twinstone/${VERSION}` } }, 9000),
      safeFetch('https://services.swpc.noaa.gov/products/noaa-scales.json', { headers: { 'Accept': 'application/json', 'User-Agent': `Twinstone/${VERSION}` } }, 9000),
    ]);
    if (!kpR.ok) throw new Error(`SWPC K-index HTTP ${kpR.status}`);
    const kpData = await kpR.json();
    let kp = null, kpAt = null;
    if (Array.isArray(kpData) && kpData.length > 1 && Array.isArray(kpData[0])) {
      const headers = kpData[0].map(x => String(x));
      const rows = kpData.slice(1).filter(Array.isArray);
      const last = rows[rows.length - 1] || [];
      const o = Object.fromEntries(headers.map((h, i) => [h, last[i]]));
      kp = Number(o.Kp ?? o.kp ?? o['Kp index']);
      kpAt = o.time_tag || o.time || null;
      if (!Number.isFinite(kp)) kp = null;
    }
    let alerts = [];
    if (alertsR.ok) {
      const a = await alertsR.json();
      const rows = Array.isArray(a) ? a : Array.isArray(a?.data) ? a.data : [];
      alerts = rows.map((x, i) => ({
        id: String(x?.product_id || x?.productId || x?.id || `swpc-alert-${i}`),
        title: cleanContextText(x?.product_id || x?.product || x?.title || 'SWPC alert', 160),
        issuedAt: x?.issue_datetime || x?.issue_datetime_utc || x?.issueTime || x?.time_tag || null,
        message: cleanContextText(x?.message || x?.description || x?.summary || '', 650),
        sourceUrl: 'https://www.swpc.noaa.gov/',
      })).sort((a,b)=>Date.parse(b.issuedAt||0)-Date.parse(a.issuedAt||0)).slice(0,5);
    }
    let scales = null;
    if (scalesR.ok) {
      const s = await scalesR.json();
      scales = s && typeof s === 'object' ? s : null;
    }
    const items = [{ id: 'swpc-current', title: 'Current global space-weather context', kp, observedAt: kpAt, noaaScales: scales, sourceUrl: 'https://www.swpc.noaa.gov/', epistemicBoundary: 'Global space-environment context. Temporal coincidence with a local system anomaly does not establish causation.' }, ...alerts];
    const payload = contextStatus('NOAA Space Weather Prediction Center', 'live', items, { scope: 'global', currentKp: kp, currentKpAt: kpAt, alertCount: alerts.length, transport: 'worker-https', caveat: 'Global context only; it does not add to geographic corroboration scores.' });
    await putJsonCache(cache, key, payload, 5 * 60);
    return payload;
  } catch (error) {
    return contextStatus('NOAA Space Weather Prediction Center', 'degraded', [], { scope: 'global', error: safeError(error), transport: 'worker-https' });
  }
}

async function fetchReliefWebContext(request, env, place) {
  const appname = secret(env, 'RELIEFWEB_APPNAME');
  if (!appname) return contextStatus('OCHA ReliefWeb API v2', 'registration-required', [], { scope: place?.country ? 'country' : 'global', country: place?.country || null, configuration: 'Set RELIEFWEB_APPNAME to a pre-approved ReliefWeb appname.', transport: null, caveat: 'ReliefWeb API v2 requires a pre-approved appname. No request is made until it is configured.' });
  const cache = caches.default;
  const country = place?.country || null;
  const key = contextCacheRequest(request, 'reliefweb-v2', `${country || 'global'}-${appname}`);
  const cached = await readJsonCache(cache, key);
  if (cached) return { ...cached, cacheState: 'fresh-cache' };
  const u = new URL('https://api.reliefweb.int/v2/reports');
  u.searchParams.set('appname', appname);
  u.searchParams.set('limit', '8');
  u.searchParams.set('preset', 'latest');
  if (country) { u.searchParams.set('filter[field]', 'primary_country'); u.searchParams.set('filter[value]', country); }
  for (const f of ['title','date.created','date.original','source.name','primary_country.name','country.name','url','headline.title','format.name']) u.searchParams.append('fields[include][]', f);
  try {
    const r = await safeFetch(u.toString(), { headers: { 'Accept':'application/json', 'User-Agent': `Twinstone/${VERSION}` } }, 10000);
    if (!r.ok) throw new Error(`ReliefWeb HTTP ${r.status}`);
    const d = await r.json();
    const rows = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];
    const items = rows.slice(0,8).map((x,i)=>{
      const f=x?.fields||x||{}, src=Array.isArray(f.source)?f.source.map(s=>s?.name).filter(Boolean).join(', '):f.source?.name||null;
      const countries=Array.isArray(f.country)?f.country.map(c=>c?.name).filter(Boolean):[];
      return { id:String(x?.id||f?.id||`relief-${i}`), title:cleanContextText(f.title||f?.headline?.title||'ReliefWeb report',240), publishedAt:f?.date?.original||f?.date?.created||null, source:cleanContextText(src||'',180)||null, countries, format:Array.isArray(f.format)?f.format.map(v=>v?.name).filter(Boolean).join(', '):null, sourceUrl:f.url||null, epistemicBoundary:'Curated humanitarian/reporting context; it is reported information, not a physical sensor observation.' };
    });
    const payload=contextStatus('OCHA ReliefWeb API v2','live',items,{scope:country?'country':'global',country,transport:'worker-https',caveat:'Reported humanitarian information. Presence near an AOI does not establish cause or corroborate a physical observation by itself.'});
    await putJsonCache(cache,key,payload,30*60);
    return payload;
  } catch(error) {
    return contextStatus('OCHA ReliefWeb API v2','degraded',[],{scope:country?'country':'global',country,error:safeError(error),transport:'worker-https'});
  }
}

async function fetchWhoContext(request, place) {
  const cache=caches.default, country=place?.country||null;
  const key=contextCacheRequest(request,'who-don-v1',country||'global');
  const cached=await readJsonCache(cache,key); if(cached)return{...cached,cacheState:'fresh-cache'};
  const u=new URL('https://www.who.int/api/news/diseaseoutbreaknews');
  u.searchParams.set('$select','Id,PublicationDateAndTime,Title,Summary,DonId,ItemDefaultUrl');
  u.searchParams.set('$top','40'); u.searchParams.set('$orderby','PublicationDateAndTime desc');
  try {
    const r=await safeFetch(u.toString(),{headers:{'Accept':'application/json','User-Agent':`Twinstone/${VERSION}`}},10000);
    if(!r.ok)throw new Error(`WHO DON HTTP ${r.status}`);
    const d=await r.json(); let rows=Array.isArray(d?.value)?d.value:Array.isArray(d)?d:[];
    if(country){const needle=country.toLowerCase();rows=rows.filter(x=>`${x?.Title||''} ${x?.Summary||''}`.toLowerCase().includes(needle));}
    const items=rows.slice(0,8).map((x,i)=>({id:String(x?.DonId||x?.Id||`who-don-${i}`),title:cleanContextText(x?.Title||'WHO Disease Outbreak News',240),publishedAt:x?.PublicationDateAndTime||null,summary:cleanContextText(x?.Summary||'',700),sourceUrl:x?.ItemDefaultUrl?`https://www.who.int${x.ItemDefaultUrl}`:'https://www.who.int/emergencies/disease-outbreak-news',epistemicBoundary:'WHO Disease Outbreak News is authoritative public-health reporting/context, not a local sensor observation.'}));
    const payload=contextStatus('WHO Disease Outbreak News','live',items,{scope:country?'country-text-match':'global',country,transport:'worker-https',caveat:country?'Country relevance is a conservative text match against the latest WHO DON titles/summaries; zero matches does not establish no health event.':'Latest global WHO Disease Outbreak News context.'});
    await putJsonCache(cache,key,payload,30*60); return payload;
  } catch(error){return contextStatus('WHO Disease Outbreak News','degraded',[],{scope:country?'country-text-match':'global',country,error:safeError(error),transport:'worker-https'});}
}

async function buildInvestigationContext(request, env, bbox, profile, areaName) {
  const url=new URL(request.url), selectedHours=Math.min(720,Math.max(1,Number(url.searchParams.get('windowHours')||24)));
  const place=await resolveInvestigationPlace(request,bbox,profile,areaName);
  const settled=await Promise.allSettled([
    fetchIodaContext(request,place,selectedHours),
    fetchSwpcContext(request),
    fetchReliefWebContext(request,env,place),
    fetchWhoContext(request,place),
  ]);
  const names=['connectivity','spaceWeather','humanitarian','publicHealth'], sources={};
  for(let i=0;i<names.length;i++)sources[names[i]]=settled[i].status==='fulfilled'?settled[i].value:contextStatus(names[i],'error',[],{error:safeError(settled[i].reason)});
  return {generatedAt:new Date().toISOString(),scope:{profile,areaName,centre:bboxCenter(bbox),windowHours:selectedHours,place},sources,epistemicBoundary:'Context sources support analyst understanding but are not map observations and do not increase deterministic corroboration scores unless a future explicit evidence rule says otherwise.'};
}


async function fetchSatelliteElements(request, ctx) {
  // CelesTrak asks GP clients to download only once per data update. GP data
  // updates about every two hours, so Twinstone keeps a two-hour edge cache,
  // a longer stale fallback, and a backoff marker after upstream errors.
  const sourceUrl = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=JSON';
  const cache = caches.default;
  const origin = new URL(request.url).origin;
  const freshKey = new Request(origin + '/__twinstone_cache/celestrak/visual/fresh', { method: 'GET' });
  const staleKey = new Request(origin + '/__twinstone_cache/celestrak/visual/stale', { method: 'GET' });
  const backoffKey = new Request(origin + '/__twinstone_cache/celestrak/visual/backoff', { method: 'GET' });

  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const cachedFresh = await cache.match(freshKey);
  if (cachedFresh) {
    const payload = await cachedFresh.json();
    return {
      ...payload,
      status: 'live',
      cacheState: 'fresh-cache',
      servedAt: nowIso,
      upstreamStatus: 'cached',
      nextUpstreamAttemptAt: payload.nextUpstreamAttemptAt || isoAfter(payload.fetchedAt || nowIso, 2 * 60 * 60),
    };
  }

  // Keep a stale copy independently so an upstream 5xx does not empty the
  // operational picture just because the two-hour fresh entry expired.
  const cachedStaleResponse = await cache.match(staleKey);
  let cachedStale = null;
  if (cachedStaleResponse) {
    try { cachedStale = await cachedStaleResponse.json(); } catch (_) { cachedStale = null; }
  }

  const backoffResponse = await cache.match(backoffKey);
  if (backoffResponse) {
    let backoff = null;
    try { backoff = await backoffResponse.json(); } catch (_) { backoff = null; }
    const error = backoff?.error || 'CelesTrak upstream retry is temporarily suppressed after an earlier failure.';
    if (cachedStale?.elements?.length) {
      return {
        ...cachedStale,
        status: 'degraded',
        cacheState: 'stale-cache',
        error,
        servedAt: nowIso,
        backoffUntil: backoff?.until || null,
        nextUpstreamAttemptAt: backoff?.until || null,
      };
    }
    return satelliteUnavailable(error, nowIso, {
      cacheState: 'no-cache',
      backoffUntil: backoff?.until || null,
      nextUpstreamAttemptAt: backoff?.until || null,
    });
  }

  let response;
  try {
    response = await safeFetch(sourceUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': `Twinstone/${VERSION} (+CelesTrak GP visual; cached 2h)`,
      },
    }, 30_000);
  } catch (error) {
    const message = `CelesTrak request failed: ${safeError(error)}`;
    const until = await setCelesTrakBackoff(cache, backoffKey, message, 30 * 60);
    if (cachedStale?.elements?.length) {
      return { ...cachedStale, status: 'degraded', cacheState: 'stale-cache', error: message, servedAt: nowIso, backoffUntil: until, nextUpstreamAttemptAt: until };
    }
    return satelliteUnavailable(message, nowIso, { cacheState: 'no-cache', backoffUntil: until, nextUpstreamAttemptAt: until });
  }

  const text = await response.text();
  if (!response.ok) {
    const message = `CelesTrak HTTP ${response.status}: ${text.slice(0, 240)}`;
    // CelesTrak documents 50x as a server-load condition. Back off instead of
    // hammering the endpoint. 403s get the full two-hour GP update interval.
    const backoffSec = response.status === 403 ? 2 * 60 * 60 :
      (response.status === 429 || response.status >= 500 ? 30 * 60 : 15 * 60);
    const until = await setCelesTrakBackoff(cache, backoffKey, message, backoffSec);
    if (cachedStale?.elements?.length) {
      return { ...cachedStale, status: 'degraded', cacheState: 'stale-cache', error: message, servedAt: nowIso, backoffUntil: until, nextUpstreamAttemptAt: until };
    }
    return satelliteUnavailable(message, nowIso, { cacheState: 'no-cache', backoffUntil: until, nextUpstreamAttemptAt: until });
  }

  let elements;
  try {
    elements = JSON.parse(text);
  } catch (_) {
    const message = 'CelesTrak returned invalid JSON.';
    const until = await setCelesTrakBackoff(cache, backoffKey, message, 30 * 60);
    if (cachedStale?.elements?.length) {
      return { ...cachedStale, status: 'degraded', cacheState: 'stale-cache', error: message, servedAt: nowIso, backoffUntil: until, nextUpstreamAttemptAt: until };
    }
    return satelliteUnavailable(message, nowIso, { cacheState: 'no-cache', backoffUntil: until, nextUpstreamAttemptAt: until });
  }

  if (!Array.isArray(elements) || !elements.length) {
    const message = 'CelesTrak returned no GP elements.';
    const until = await setCelesTrakBackoff(cache, backoffKey, message, 30 * 60);
    if (cachedStale?.elements?.length) {
      return { ...cachedStale, status: 'degraded', cacheState: 'stale-cache', error: message, servedAt: nowIso, backoffUntil: until, nextUpstreamAttemptAt: until };
    }
    return satelliteUnavailable(message, nowIso, { cacheState: 'no-cache', backoffUntil: until, nextUpstreamAttemptAt: until });
  }

  const fetchedAt = nowIso;
  const payload = {
    status: 'live',
    provider: 'CelesTrak',
    group: 'visual',
    elementCount: elements.length,
    error: null,
    elements,
    fetchedAt,
    sourceUrl,
    cacheState: 'origin',
    nextUpstreamAttemptAt: isoAfter(fetchedAt, 2 * 60 * 60),
    propagation: {
      method: 'SGP4',
      clientLibrary: 'satellite.js',
      positionNature: 'propagated estimate from GP/OMM elements',
    },
  };

  // The fresh entry enforces the normal two-hour cadence. The stale entry is
  // deliberately longer-lived so temporary CelesTrak outages do not remove
  // already-downloaded orbital data from the PoC.
  await Promise.all([
    cache.put(freshKey, cacheJsonResponse(payload, 2 * 60 * 60)),
    cache.put(staleKey, cacheJsonResponse(payload, 24 * 60 * 60)),
    cache.delete(backoffKey),
  ]);

  return { ...payload, servedAt: nowIso };
}

function cacheJsonResponse(data, ttlSeconds) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `s-maxage=${ttlSeconds}`,
    },
  });
}

function isoAfter(base, seconds) {
  const t = Date.parse(base);
  return new Date((Number.isFinite(t) ? t : Date.now()) + seconds * 1000).toISOString();
}

async function setCelesTrakBackoff(cache, key, error, seconds) {
  const until = new Date(Date.now() + seconds * 1000).toISOString();
  await cache.put(key, cacheJsonResponse({ error, until }, seconds));
  return until;
}

function satelliteUnavailable(error, fetchedAt, extra = {}) {
  return {
    status: 'degraded',
    provider: 'CelesTrak',
    group: 'visual',
    elementCount: 0,
    error,
    elements: [],
    fetchedAt,
    propagation: {
      method: 'SGP4',
      clientLibrary: 'satellite.js',
      positionNature: 'propagated estimate from GP/OMM elements',
    },
    ...extra,
  };
}

function aircraftRadiusBucketNm(requiredNm) {
  const buckets = [50, 75, 100, 125, 150, 175, 200, 225, 250];
  const n = Math.max(10, Number(requiredNm || 10));
  return buckets.find(v => v >= n) || 250;
}

function aircraftAcquisitionPlan(bbox) {
  const requested = bboxCenter(bbox);
  // A 1-degree centre grid means nearby Investigation AOIs reuse the same
  // upstream aircraft picture instead of every arbitrary rectangle creating a
  // completely new cache key/request. Radius buckets preserve full AOI coverage.
  let centre = {
    lat: Math.max(-89, Math.min(89, Math.round(requested.lat))),
    lon: Math.max(-179, Math.min(179, Math.round(requested.lon))),
  };
  const corners = [
    [bbox.south, bbox.west], [bbox.south, bbox.east],
    [bbox.north, bbox.west], [bbox.north, bbox.east],
  ];
  let requiredKm = Math.max(...corners.map(([lat, lon]) => haversineKm(centre.lat, centre.lon, lat, lon))) + 8;
  let requiredNm = requiredKm / 1.852;
  // The ADSB.lol point endpoint accepts up to 250 NM. For an unusually large
  // or edge-clamped AOI, prefer the real AOI centre before declaring partial
  // acquisition coverage. Current 10/25/50/100 km investigations fit easily.
  if (requiredNm > 250) {
    centre = requested;
    requiredKm = Math.max(...corners.map(([lat, lon]) => haversineKm(centre.lat, centre.lon, lat, lon))) + 8;
    requiredNm = requiredKm / 1.852;
  }
  const approximateAoiRadiusKm = Math.max(0, (bbox.north - bbox.south) * 111.32 / 2);
  const policyFloorNm = approximateAoiRadiusKm >= 80 ? 125 : approximateAoiRadiusKm >= 40 ? 100 : 75;
  const radiusNm = Math.max(policyFloorNm, aircraftRadiusBucketNm(requiredNm));
  const coverageComplete = requiredNm <= 250;
  return {
    centre: { lat: +centre.lat.toFixed(4), lon: +centre.lon.toFixed(4) },
    radiusNm,
    requiredNm: +requiredNm.toFixed(1),
    coverageComplete,
    cacheCell: `${centre.lat.toFixed(0)}_${centre.lon.toFixed(0)}_${radiusNm}nm`,
    gridDegrees: 1,
  };
}

function aircraftPayloadForAoi(regionPayload, bbox, extra = {}) {
  const regional = Array.isArray(regionPayload?.observations) ? regionPayload.observations : [];
  const observations = regional.filter(o => {
    const lat = Number(o?.location?.lat), lon = Number(o?.location?.lon);
    return Number.isFinite(lat) && Number.isFinite(lon) && inBBox(lat, lon, bbox);
  });
  const acquisitionRegion = regionPayload?.acquisitionRegion || null;
  return {
    ...regionPayload,
    ...extra,
    observations,
    acquisitionRegion,
    metrics: {
      ...(regionPayload?.metrics || {}),
      regionalAircraft: regional.length,
      aoiAircraft: observations.length,
      cacheCell: acquisitionRegion?.cacheCell || null,
      acquisitionRadiusNm: acquisitionRegion?.radiusNm ?? null,
      acquisitionCentreLat: acquisitionRegion?.centre?.lat ?? null,
      acquisitionCentreLon: acquisitionRegion?.centre?.lon ?? null,
      coverageComplete: acquisitionRegion?.coverageComplete !== false,
    },
  };
}

async function fetchAircraftOperational(request, env, bbox) {
  const REFRESH_SEC = 300;
  const STALE_SEC = 60 * 60;
  const OPENSKY_FRESH_SEC = 180;
  const OPENSKY_STALE_SEC = 15 * 60;
  const cache = caches.default;
  const origin = new URL(request.url).origin;
  const plan = aircraftAcquisitionPlan(bbox);
  const base = `${origin}/__twinstone_cache/aircraft-regional-v2/${plan.cacheCell}`;
  const freshKey = new Request(base + '/fresh', { method: 'GET' });
  const staleKey = new Request(base + '/stale', { method: 'GET' });
  const backoffKey = new Request(base + '/adsblol-backoff', { method: 'GET' });
  const aoiSig = [bbox.south, bbox.west, bbox.north, bbox.east].map(v => Number(v).toFixed(3)).join('_');
  const osBase = `${origin}/__twinstone_cache/aircraft-opensky-anon-v1/${aoiSig}`;
  const osFreshKey = new Request(osBase + '/fresh', { method: 'GET' });
  const osStaleKey = new Request(osBase + '/stale', { method: 'GET' });
  const osBackoffKey = new Request(base + '/opensky-anon-backoff', { method: 'GET' });
  const nowIso = new Date().toISOString();

  const fresh = await readJsonCache(cache, freshKey);
  if (fresh && Array.isArray(fresh.observations)) {
    return aircraftPayloadForAoi(fresh, bbox, {
      status: 'live', cacheState: 'fresh-cache', upstreamStatus: 'cached', servedAt: nowIso,
      nextUpstreamAttemptAt: fresh.nextUpstreamAttemptAt || new Date(Date.now() + REFRESH_SEC * 1000).toISOString(),
    });
  }

  const stale = await readJsonCache(cache, staleKey);
  const backoff = await readJsonCache(cache, backoffKey);
  const adsbBlocked = backoff?.until && Date.parse(backoff.until) > Date.now();

  // If ADSB.lol is already backed off and we hold a real regional snapshot,
  // preserve it immediately. This avoids turning a temporary provider error
  // into a false zero-aircraft picture or delaying the full snapshot.
  if (adsbBlocked && stale && Array.isArray(stale.observations)) {
    return aircraftPayloadForAoi(stale, bbox, {
      status: 'fallback', cacheState: 'stale-cache', upstreamStatus: 'degraded',
      error: `ADSB.lol backoff active until ${backoff.until}: ${backoff.error || ''}`,
      nextUpstreamAttemptAt: backoff.until, servedAt: nowIso,
      providerPool: { active: stale.provider || 'ADSB.lol cached', primary: 'ADSB.lol', coldStartFallback: 'OpenSky anonymous', degraded: true },
    });
  }

  let adsbError = null;
  if (!adsbBlocked) {
    try {
      const regionalObservations = await fetchAdsbLolPoint(plan.centre, plan.radiusNm);
      const regionPayload = {
        feed: 'aircraft', provider: 'ADSB.lol', status: 'live', observations: regionalObservations,
        error: null, cacheState: 'origin', upstreamStatus: 'live', sourceDataFetchedAt: nowIso,
        lastSuccessfulSnapshotAt: nowIso, lastUpstreamAttemptAt: nowIso,
        nextUpstreamAttemptAt: new Date(Date.now() + REFRESH_SEC * 1000).toISOString(),
        transport: 'worker-https',
        acquisitionRegion: plan,
        providerPool: { active: 'ADSB.lol', primary: 'ADSB.lol', acquisitionSeconds: REFRESH_SEC, coldStartFallback: 'OpenSky anonymous' },
      };
      // Cache successful zero-result responses as successful source snapshots too;
      // otherwise an empty region would be hammered every browser poll.
      await putJsonCache(cache, freshKey, regionPayload, REFRESH_SEC);
      await putJsonCache(cache, staleKey, regionPayload, STALE_SEC);
      await cache.delete(backoffKey);
      return aircraftPayloadForAoi(regionPayload, bbox);
    } catch (error) {
      adsbError = error;
      const status = Number(error?.status || 0);
      const defaultBackoff = status === 429 ? 10 * 60 : (status >= 500 ? 3 * 60 : 2 * 60);
      const backoffSec = Math.max(60, Math.min(30 * 60, Number(error?.retryAfterSec || defaultBackoff)));
      await setAircraftBackoff(cache, backoffKey, safeError(error), backoffSec);
      // A last-known-good regional picture is preferable to waiting on a second
      // provider that is known to be unreliable from the Worker environment.
      if (stale && Array.isArray(stale.observations)) {
        return aircraftPayloadForAoi(stale, bbox, {
          status: 'fallback', cacheState: 'stale-cache', upstreamStatus: 'degraded',
          error: `ADSB.lol ${safeError(error)}`, lastUpstreamAttemptAt: nowIso,
          nextUpstreamAttemptAt: new Date(Date.now() + backoffSec * 1000).toISOString(), servedAt: nowIso,
          providerPool: { active: stale.provider || 'ADSB.lol cached', primary: 'ADSB.lol', coldStartFallback: 'OpenSky anonymous', degraded: true },
        });
      }
    }
  } else {
    adsbError = new Error(`ADSB.lol backoff active until ${backoff.until}`);
  }

  // Cold-start only fallback. OpenSky OAuth remains diagnostic because its auth
  // route is unreliable from Cloudflare; anonymous states is bounded to 6 s and
  // only attempted when ADSB.lol has failed and no reusable regional snapshot exists.
  const osFresh = await readJsonCache(cache, osFreshKey);
  if (osFresh && Array.isArray(osFresh.observations)) {
    return {
      ...osFresh, status: 'fallback', cacheState: 'fresh-cache', upstreamStatus: 'cached-fallback', servedAt: nowIso,
      error: adsbError ? `ADSB.lol ${safeError(adsbError)}; using cached OpenSky anonymous fallback.` : osFresh.error,
    };
  }
  const osStale = await readJsonCache(cache, osStaleKey);
  const osBackoff = await readJsonCache(cache, osBackoffKey);
  const osBlocked = osBackoff?.until && Date.parse(osBackoff.until) > Date.now();
  if (!osBlocked) {
    try {
      const observations = await fetchOpenSky(env, bbox, { authenticated: false, timeoutMs: 6_000 });
      const payload = {
        feed: 'aircraft', provider: 'OpenSky anonymous', status: 'fallback', observations,
        error: adsbError ? `ADSB.lol ${safeError(adsbError)}; OpenSky anonymous cold-start fallback active.` : null,
        cacheState: 'origin-fallback', upstreamStatus: 'fallback-live', sourceDataFetchedAt: nowIso,
        lastSuccessfulSnapshotAt: nowIso, lastUpstreamAttemptAt: nowIso,
        nextUpstreamAttemptAt: new Date(Date.now() + OPENSKY_FRESH_SEC * 1000).toISOString(),
        transport: 'worker-https',
        acquisitionRegion: { ...plan, providerCoverage: 'requested AOI only' },
        metrics: { regionalAircraft: observations.length, aoiAircraft: observations.length, cacheCell: plan.cacheCell, acquisitionRadiusNm: plan.radiusNm, coverageComplete: true },
        providerPool: { active: 'OpenSky anonymous', primary: 'ADSB.lol', coldStartFallback: 'OpenSky anonymous', fallbackReason: adsbError ? safeError(adsbError) : 'ADSB.lol unavailable' },
      };
      await putJsonCache(cache, osFreshKey, payload, OPENSKY_FRESH_SEC);
      await putJsonCache(cache, osStaleKey, payload, OPENSKY_STALE_SEC);
      await cache.delete(osBackoffKey);
      return payload;
    } catch (error) {
      const status = Number(error?.status || 0);
      const defaultBackoff = status === 429 ? 15 * 60 : 5 * 60;
      const backoffSec = Math.max(60, Math.min(30 * 60, Number(error?.retryAfterSec || defaultBackoff)));
      await setAircraftBackoff(cache, osBackoffKey, safeError(error), backoffSec);
      if (osStale && Array.isArray(osStale.observations)) {
        return {
          ...osStale, status: 'fallback', cacheState: 'stale-cache', upstreamStatus: 'degraded', servedAt: nowIso,
          error: `ADSB.lol ${safeError(adsbError)}; OpenSky ${safeError(error)}; retaining OpenSky last-known-good.`,
          nextUpstreamAttemptAt: new Date(Date.now() + backoffSec * 1000).toISOString(),
        };
      }
      return {
        feed: 'aircraft', provider: 'ADSB.lol + OpenSky anonymous', status: 'degraded', observations: [],
        error: `Aircraft sources unavailable for this acquisition cell. ADSB.lol: ${safeError(adsbError)}; OpenSky: ${safeError(error)}`,
        cacheState: 'no-cache', upstreamStatus: 'degraded', lastUpstreamAttemptAt: nowIso,
        nextUpstreamAttemptAt: new Date(Date.now() + Math.min(5 * 60, backoffSec) * 1000).toISOString(),
        transport: 'worker-https', acquisitionRegion: plan,
        metrics: { regionalAircraft: 0, aoiAircraft: 0, cacheCell: plan.cacheCell, acquisitionRadiusNm: plan.radiusNm, coverageComplete: plan.coverageComplete },
        providerPool: { active: 'none', primary: 'ADSB.lol', coldStartFallback: 'OpenSky anonymous', degraded: true },
      };
    }
  }

  if (osStale && Array.isArray(osStale.observations)) {
    return {
      ...osStale, status: 'fallback', cacheState: 'stale-cache', upstreamStatus: 'degraded', servedAt: nowIso,
      error: `ADSB.lol ${safeError(adsbError)}; OpenSky backoff active until ${osBackoff.until}; retaining OpenSky last-known-good.`,
      nextUpstreamAttemptAt: osBackoff.until,
    };
  }
  return {
    feed: 'aircraft', provider: 'ADSB.lol + OpenSky anonymous', status: 'degraded', observations: [],
    error: `Aircraft acquisition unavailable. ADSB.lol: ${safeError(adsbError)}; OpenSky backoff active until ${osBackoff?.until || 'unknown'}.`,
    cacheState: 'no-cache', upstreamStatus: 'degraded', transport: 'worker-https', acquisitionRegion: plan,
    metrics: { regionalAircraft: 0, aoiAircraft: 0, cacheCell: plan.cacheCell, acquisitionRadiusNm: plan.radiusNm, coverageComplete: plan.coverageComplete },
    providerPool: { active: 'none', primary: 'ADSB.lol', coldStartFallback: 'OpenSky anonymous', degraded: true },
  };
}

async function fetchAircraft(request, env, bbox) {
  // v1.1 provider-pool acquisition.
  //
  // With OpenSky OAuth configured, Twinstone can refresh a <=25 sq° AOI once
  // per minute while remaining comfortably inside the standard 4,000 credits/day
  // /states bucket (1 credit per request for this AOI). Without OAuth, anonymous
  // OpenSky is limited to 400 credits/day, so use a conservative 270-second
  // cadence and retain ADSB.lol as an independent fallback.
  const OPEN_SKY_AUTH_REFRESH_SEC = 60;
  const OPEN_SKY_ANON_REFRESH_SEC = 270;
  const ADSB_LOL_REFRESH_SEC = 300;
  const AIRCRAFT_STALE_CACHE_SEC = 60 * 60;
  const hasOAuth = Boolean(secret(env, 'OPENSKY_CLIENT_ID') && secret(env, 'OPENSKY_CLIENT_SECRET'));
  const acquisitionSec = hasOAuth ? OPEN_SKY_AUTH_REFRESH_SEC : OPEN_SKY_ANON_REFRESH_SEC;

  const cache = caches.default;
  const origin = new URL(request.url).origin;
  const sig = [bbox.south, bbox.west, bbox.north, bbox.east].map(v => Number(v).toFixed(3)).join('_');
  // v2 namespace intentionally invalidates the older single-provider cadence cache.
  const base = `${origin}/__twinstone_cache/aircraft-v3/${sig}`;
  const freshKey = new Request(base + '/fresh', { method: 'GET' });
  const staleKey = new Request(base + '/stale', { method: 'GET' });
  const openSkyBackoffKey = new Request(base + (hasOAuth ? '/opensky-oauth-backoff' : '/opensky-anon-backoff'), { method: 'GET' });
  const adsbBackoffKey = new Request(base + '/adsblol-backoff', { method: 'GET' });
  const openSkyTokenCacheKey = new Request(`${origin}/__twinstone_cache/opensky-token-v2`, { method: 'GET' });
  const nowIso = new Date().toISOString();

  const fresh = await readJsonCache(cache, freshKey);
  if (fresh?.observations?.length) {
    return {
      ...fresh,
      cacheState: 'fresh-cache',
      servedAt: nowIso,
      upstreamStatus: 'cached',
    };
  }

  const stale = await readJsonCache(cache, staleKey);
  const attempts = [];

  // ---- Provider 1: OpenSky (OAuth if configured, otherwise anonymous) ----
  const osBackoff = await readJsonCache(cache, openSkyBackoffKey);
  const osBlocked = osBackoff?.until && Date.parse(osBackoff.until) > Date.now();
  if (!osBlocked) {
    try {
      const observations = await fetchOpenSky(env, bbox, { authenticated: hasOAuth, cache, tokenCacheKey: openSkyTokenCacheKey });
      if (observations.length) {
        const provider = hasOAuth ? 'OpenSky OAuth' : 'OpenSky anonymous';
        const payload = {
          feed: 'aircraft',
          provider,
          status: 'live',
          observations,
          error: null,
          cacheState: 'origin',
          upstreamStatus: 'live',
          sourceDataFetchedAt: nowIso,
          lastSuccessfulSnapshotAt: nowIso,
          lastUpstreamAttemptAt: nowIso,
          nextUpstreamAttemptAt: new Date(Date.now() + acquisitionSec * 1000).toISOString(),
          providerPool: {
            active: provider,
            openSkyMode: hasOAuth ? 'oauth' : 'anonymous',
            acquisitionSeconds: acquisitionSec,
            fallback: 'ADSB.lol',
          },
        };
        await putJsonCache(cache, freshKey, payload, acquisitionSec);
        await putJsonCache(cache, staleKey, payload, AIRCRAFT_STALE_CACHE_SEC);
        await cache.delete(openSkyBackoffKey);
        return payload;
      }
      attempts.push(`${hasOAuth ? 'OpenSky OAuth' : 'OpenSky anonymous'} returned no positioned aircraft`);
    } catch (error) {
      const status = Number(error?.status || 0);
      const defaultBackoff = status === 429 ? (hasOAuth ? 5 * 60 : 30 * 60) : (status >= 500 ? 2 * 60 : 3 * 60);
      const backoffSec = Math.max(60, Math.min(24 * 60 * 60, Number(error?.retryAfterSec || defaultBackoff)));
      const until = await setAircraftBackoff(cache, openSkyBackoffKey, safeError(error), backoffSec);
      attempts.push(`${hasOAuth ? 'OpenSky OAuth' : 'OpenSky anonymous'} ${safeError(error)} (retry after ${until})`);
    }
  } else {
    attempts.push(`${hasOAuth ? 'OpenSky OAuth' : 'OpenSky anonymous'} backoff active until ${osBackoff.until}`);
  }

  // ---- Provider 2: ADSB.lol independent fallback ----
  const adsbBackoff = await readJsonCache(cache, adsbBackoffKey);
  const adsbBlocked = adsbBackoff?.until && Date.parse(adsbBackoff.until) > Date.now();
  if (!adsbBlocked) {
    try {
      const observations = await fetchAdsbLol(bbox);
      if (observations.length) {
        const payload = {
          feed: 'aircraft',
          provider: 'ADSB.lol',
          status: 'fallback',
          observations,
          error: attempts.length ? attempts.join('; ') : null,
          cacheState: 'origin',
          upstreamStatus: 'fallback-live',
          sourceDataFetchedAt: nowIso,
          lastSuccessfulSnapshotAt: nowIso,
          lastUpstreamAttemptAt: nowIso,
          nextUpstreamAttemptAt: new Date(Date.now() + ADSB_LOL_REFRESH_SEC * 1000).toISOString(),
          providerPool: {
            active: 'ADSB.lol',
            openSkyMode: hasOAuth ? 'oauth' : 'anonymous',
            acquisitionSeconds: ADSB_LOL_REFRESH_SEC,
            fallbackReason: attempts.join('; ') || 'OpenSky unavailable',
          },
        };
        await putJsonCache(cache, freshKey, payload, Math.min(acquisitionSec, ADSB_LOL_REFRESH_SEC));
        await putJsonCache(cache, staleKey, payload, AIRCRAFT_STALE_CACHE_SEC);
        await cache.delete(adsbBackoffKey);
        return payload;
      }
      attempts.push('ADSB.lol returned no positioned aircraft');
    } catch (error) {
      const status = Number(error?.status || 0);
      const defaultBackoff = status === 429 ? 5 * 60 : (status >= 500 ? 2 * 60 : 3 * 60);
      const backoffSec = Math.max(60, Math.min(15 * 60, Number(error?.retryAfterSec || defaultBackoff)));
      const until = await setAircraftBackoff(cache, adsbBackoffKey, safeError(error), backoffSec);
      attempts.push(`ADSB.lol ${safeError(error)} (retry after ${until})`);
    }
  } else {
    attempts.push(`ADSB.lol backoff active until ${adsbBackoff.until}`);
  }

  // Both live providers unavailable. Preserve the last successful provider picture.
  if (stale?.observations?.length) {
    const nextCandidates = [
      osBlocked ? osBackoff?.until : null,
      adsbBlocked ? adsbBackoff?.until : null,
    ].filter(Boolean).map(Date.parse).filter(Number.isFinite);
    const next = nextCandidates.length ? new Date(Math.min(...nextCandidates)).toISOString() : new Date(Date.now() + 60_000).toISOString();
    return {
      ...stale,
      status: 'fallback',
      cacheState: 'stale-cache',
      upstreamStatus: 'degraded',
      error: attempts.join('; '),
      servedAt: nowIso,
      lastUpstreamAttemptAt: nowIso,
      nextUpstreamAttemptAt: next,
      providerPool: {
        active: stale.provider || 'last-known-good',
        openSkyMode: hasOAuth ? 'oauth' : 'anonymous',
        degraded: true,
        attempts,
      },
    };
  }

  throw new Error(`Aircraft provider pool unavailable: ${attempts.join('; ')}`);
}
async function readJsonCache(cache, key) {
  const response = await cache.match(key);
  if (!response) return null;
  try { return await response.json(); } catch (_) { return null; }
}

async function putJsonCache(cache, key, payload, ttlSeconds) {
  const response = new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${Math.max(1, Math.floor(ttlSeconds))}`,
    },
  });
  await cache.put(key, response);
}

async function setAircraftBackoff(cache, key, error, seconds) {
  const until = new Date(Date.now() + seconds * 1000).toISOString();
  await putJsonCache(cache, key, { until, error, setAt: new Date().toISOString() }, seconds);
  return until;
}

function retryAfterSeconds(value) {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, Math.ceil((when - Date.now()) / 1000));
  return null;
}

async function sleepMs(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function openSkyAuthError(message, status = 0, retryAfterSec = null) {
  const error = new Error(message);
  error.status = status;
  error.retryAfterSec = retryAfterSec;
  return error;
}

async function invalidateOpenSkyToken(cache, tokenCacheKey) {
  openSkyToken = null;
  openSkyTokenExpiresAt = 0;
  if (cache && tokenCacheKey) {
    try { await cache.delete(tokenCacheKey); } catch (_) {}
  }
}

async function acquireOpenSkyToken(env, cache, tokenCacheKey) {
  const clientId = secret(env, 'OPENSKY_CLIENT_ID');
  const clientSecret = secret(env, 'OPENSKY_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw openSkyAuthError('OpenSky OAuth credentials not configured.', 401);

  const authUrl = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();

  const attempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await safeFetch(authUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body,
      }, 30_000);

      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch (_) { data = null; }

      if (!response.ok) {
        const message = data?.error_description || data?.error || text.slice(0, 240) || `HTTP ${response.status}`;
        const retryAfterSec = retryAfterSeconds(response.headers.get('Retry-After'));
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        const error = openSkyAuthError(`OpenSky OAuth HTTP ${response.status}: ${message}`, response.status, retryAfterSec);
        if (!retryable || attempt === attempts) throw error;
        lastError = error;
      } else {
        if (!data?.access_token) throw openSkyAuthError('OpenSky OAuth response contained no access token.', 502);

        const now = Date.now();
        const expiresInSec = Math.max(60, Number(data.expires_in || 1800));
        openSkyToken = data.access_token;
        openSkyTokenExpiresAt = now + expiresInSec * 1000;

        // Cache for 25 minutes (or less if OpenSky returns a shorter lifetime).
        // The cache key is never exposed by a Worker route; this is only an
        // internal resilience cache so cold Worker isolates do not re-authenticate.
        const cacheTtlSec = Math.max(30, Math.min(1500, expiresInSec - 120));
        if (cache && tokenCacheKey) {
          try {
            await putJsonCache(cache, tokenCacheKey, {
              accessToken: openSkyToken,
              expiresAt: new Date(openSkyTokenExpiresAt).toISOString(),
              cachedAt: new Date(now).toISOString(),
            }, cacheTtlSec);
          } catch (_) {}
        }
        return openSkyToken;
      }
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const retryable = status === 0 || status === 408 || status === 429 || status >= 500 || /Timeout|network|fetch/i.test(safeError(error));
      if (!retryable || attempt === attempts) throw error;
    }

    const baseDelay = Math.min(4000, 600 * (2 ** (attempt - 1)));
    const jitter = Math.floor(Math.random() * 450);
    const retryAfterMs = Math.max(0, Number(lastError?.retryAfterSec || 0) * 1000);
    await sleepMs(Math.max(baseDelay + jitter, Math.min(retryAfterMs, 10_000)));
  }

  throw lastError || openSkyAuthError('OpenSky OAuth token acquisition failed.', 503);
}

async function getOpenSkyToken(env, { cache = null, tokenCacheKey = null } = {}) {
  const now = Date.now();
  if (openSkyToken && now < openSkyTokenExpiresAt - 60_000) return openSkyToken;

  // Module globals are fast but not durable across Worker isolates. Use the
  // internal Worker Cache API as a second layer so a cold isolate can reuse a
  // still-valid token without hitting auth.opensky-network.org again.
  if (cache && tokenCacheKey) {
    try {
      const cached = await readJsonCache(cache, tokenCacheKey);
      const expiresAt = Date.parse(cached?.expiresAt || '');
      if (cached?.accessToken && Number.isFinite(expiresAt) && now < expiresAt - 60_000) {
        openSkyToken = cached.accessToken;
        openSkyTokenExpiresAt = expiresAt;
        return openSkyToken;
      }
    } catch (_) {}
  }

  // Deduplicate concurrent token requests inside the same isolate.
  if (!openSkyTokenPromise) {
    openSkyTokenPromise = acquireOpenSkyToken(env, cache, tokenCacheKey)
      .finally(() => { openSkyTokenPromise = null; });
  }
  return await openSkyTokenPromise;
}

async function fetchOpenSky(env, bbox, { authenticated = true, cache = null, tokenCacheKey = null, timeoutMs = 25_000 } = {}) {
  const u = new URL('https://opensky-network.org/api/states/all');
  u.searchParams.set('lamin', bbox.south);
  u.searchParams.set('lomin', bbox.west);
  u.searchParams.set('lamax', bbox.north);
  u.searchParams.set('lomax', bbox.east);
  u.searchParams.set('extended', '1');

  const makeHeaders = token => {
    const headers = { 'Accept': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  };

  let token = null;
  if (authenticated) token = await getOpenSkyToken(env, { cache, tokenCacheKey });

  let response = await safeFetch(u.toString(), { headers: makeHeaders(token) }, timeoutMs);

  // If a cached bearer token was revoked or expired unexpectedly, invalidate
  // it and perform one clean OAuth refresh before giving up or falling back.
  if (authenticated && response.status === 401) {
    await invalidateOpenSkyToken(cache, tokenCacheKey);
    token = await getOpenSkyToken(env, { cache, tokenCacheKey });
    response = await safeFetch(u.toString(), { headers: makeHeaders(token) }, timeoutMs);
  }

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    error.retryAfterSec = retryAfterSeconds(
      response.headers.get('X-Rate-Limit-Retry-After-Seconds') ||
      response.headers.get('Retry-After')
    );
    throw error;
  }
  const data = await response.json();

  return (data.states || []).map(s => {
    const lon = Number(s[5]);
    const lat = Number(s[6]);
    if (!inBBox(lat, lon, bbox)) return null;

    const icao = String(s[0] || '').trim().toLowerCase();
    const callsign = String(s[1] || '').trim();
    const contactSeconds = Number(s[3] || s[4] || Math.floor(Date.now() / 1000));
    const velocityMs = Number(s[9]);
    const altitudeM = Number(s[7]);

    return makeObservation({
      source: 'OpenSky',
      observationType: `${TW}AircraftPositionObservation`,
      entityId: `urn:twinstone:aircraft:icao24:${icao || 'unknown'}`,
      entityType: `${TW}Aircraft`,
      observedAt: new Date(contactSeconds * 1000).toISOString(),
      lat,
      lon,
      label: callsign || icao || 'Unknown aircraft',
      sourceRecordId: icao,
      kinematics: {
        altitudeFt: Number.isFinite(altitudeM) ? Math.round(altitudeM * 3.28084) : null,
        speedKts: Number.isFinite(velocityMs) ? Number((velocityMs * 1.94384).toFixed(1)) : null,
        headingDeg: Number.isFinite(Number(s[10])) ? Number(s[10]) : null,
        verticalRateMps: Number.isFinite(Number(s[11])) ? Number(s[11]) : null,
      },
      attributes: {
        icao24: icao,
        callsign: callsign || null,
        originCountry: s[2] || null,
        onGround: Boolean(s[8]),
        squawk: s[14] || null,
        category: s[17] ?? null,
        positionSource: s[16] ?? null,
        accessMode: authenticated ? 'oauth' : 'anonymous',
      },
    });
  }).filter(Boolean);
}
async function fetchAdsbLol(bbox) {
  const c = bboxCenter(bbox);
  const cornerKm = Math.max(
    haversineKm(c.lat, c.lon, bbox.south, bbox.west),
    haversineKm(c.lat, c.lon, bbox.north, bbox.east),
  );
  const radiusNm = Math.min(250, Math.max(10, Math.ceil(cornerKm / 1.852)));
  const observations = await fetchAdsbLolPoint(c, radiusNm);
  return observations.filter(o => inBBox(Number(o?.location?.lat), Number(o?.location?.lon), bbox));
}

async function fetchAdsbLolPoint(c, radiusNm) {
  const radius = Math.min(250, Math.max(10, Math.ceil(Number(radiusNm) || 10)));
  const url = `https://api.adsb.lol/v2/point/${Number(c.lat).toFixed(4)}/${Number(c.lon).toFixed(4)}/${radius}`;
  const response = await safeFetch(url, { headers: { 'Accept': 'application/json' } }, 12_000);
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    error.retryAfterSec = retryAfterSeconds(response.headers.get('Retry-After'));
    throw error;
  }
  const data = await response.json();
  return (data.ac || []).map(a => {
    const lat = Number(a.lat);
    const lon = Number(a.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const icao = String(a.hex || '').replace(/^~/, '').trim().toLowerCase();
    const callsign = String(a.flight || '').trim();
    const seenSeconds = Number(a.seen || a.seen_pos || 0);
    const observedAt = new Date(Date.now() - Math.max(0, seenSeconds) * 1000).toISOString();
    const altitudeFt = typeof a.alt_baro === 'number' ? a.alt_baro :
      (typeof a.alt_geom === 'number' ? a.alt_geom : null);
    return makeObservation({
      source: 'ADSB.lol',
      observationType: `${TW}AircraftPositionObservation`,
      entityId: `urn:twinstone:aircraft:icao24:${icao || 'unknown'}`,
      entityType: `${TW}Aircraft`,
      observedAt,
      lat,
      lon,
      label: callsign || a.r || icao || 'Unknown aircraft',
      sourceRecordId: icao,
      kinematics: {
        altitudeFt,
        speedKts: Number.isFinite(Number(a.gs)) ? Number(a.gs) : null,
        headingDeg: Number.isFinite(Number(a.track)) ? Number(a.track) : null,
        verticalRateFpm: Number.isFinite(Number(a.baro_rate)) ? Number(a.baro_rate) : null,
      },
      attributes: {
        icao24: icao,
        callsign: callsign || null,
        registration: a.r || null,
        aircraftType: a.t || null,
        category: a.category || null,
        squawk: a.squawk || null,
        emergency: a.emergency || null,
        onGround: a.alt_baro === 'ground',
      },
    });
  }).filter(Boolean);
}

async function diagnoseCopernicusImagery(env) {
  const configured = Boolean(cdseClientId(env) && cdseClientSecret(env));
  if (!configured) return {
    status: 'not-configured',
    configured: false,
    oauth: 'not-tested',
    requiredSecrets: ['COPERNICUS_CLIENT_ID', 'COPERNICUS_CLIENT_SECRET'],
    note: 'Secret values are never returned.',
  };
  const started = Date.now();
  try {
    await getCdseToken(env, true);
    return {
      status: 'ok',
      configured: true,
      oauth: 'ok',
      latencyMs: Date.now() - started,
      tokenReturnedToBrowser: false,
      nextStep: 'Use a Sentinel marker -> Inspect imagery -> Load processed image to exercise the Process API.',
    };
  } catch (error) {
    return {
      status: 'error',
      configured: true,
      oauth: 'failed',
      latencyMs: Date.now() - started,
      detail: safeError(error),
      tokenReturnedToBrowser: false,
    };
  }
}

function cdseClientId(env) {
  return secret(env, 'COPERNICUS_CLIENT_ID', 'CDSE_CLIENT_ID', 'SENTINEL_HUB_CLIENT_ID');
}

function cdseClientSecret(env) {
  return secret(env, 'COPERNICUS_CLIENT_SECRET', 'CDSE_CLIENT_SECRET', 'SENTINEL_HUB_CLIENT_SECRET');
}

async function getCdseToken(env, forceRefresh = false) {
  const clientId = cdseClientId(env);
  const clientSecret = cdseClientSecret(env);
  if (!clientId || !clientSecret) {
    throw new Error('Copernicus Process API credentials are not configured. Add COPERNICUS_CLIENT_ID and COPERNICUS_CLIENT_SECRET as Worker secrets.');
  }

  const now = Date.now();
  if (!forceRefresh && cdseToken && now < cdseTokenExpiresAt - 60_000) return cdseToken;
  if (!forceRefresh && cdseTokenPromise) return cdseTokenPromise;

  const acquire = async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }).toString();
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await safeFetch(
          'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
          },
          20_000,
        );
        if (!response.ok) {
          const text = await response.text();
          if (response.status === 400 || response.status === 401 || response.status === 403) {
            throw new Error(`Copernicus OAuth HTTP ${response.status}: ${text.slice(0, 180)}`);
          }
          throw new Error(`Copernicus OAuth HTTP ${response.status}`);
        }
        const data = await response.json();
        if (!data?.access_token) throw new Error('Copernicus OAuth response did not contain an access token');
        const expiresIn = Math.max(300, Number(data.expires_in || 3600));
        cdseToken = data.access_token;
        cdseTokenExpiresAt = Date.now() + expiresIn * 1000;
        return cdseToken;
      } catch (error) {
        lastError = error;
        if (/HTTP 40[013]/.test(String(error?.message || ''))) break;
        if (attempt < 2) await new Promise(r => setTimeout(r, 500 + Math.floor(Math.random() * 500)));
      }
    }
    throw lastError || new Error('Copernicus OAuth failed');
  };

  cdseTokenPromise = acquire().finally(() => { cdseTokenPromise = null; });
  return cdseTokenPromise;
}

function imageryBounds(lat, lon, sizeKm) {
  const size = Math.max(5, Math.min(50, Number(sizeKm || 20)));
  const half = size / 2;
  const latDelta = half / 111.32;
  const cos = Math.max(0.2, Math.cos(Number(lat) * Math.PI / 180));
  const lonDelta = half / (111.32 * cos);
  return {
    west: Number(lon) - lonDelta,
    south: Number(lat) - latDelta,
    east: Number(lon) + lonDelta,
    north: Number(lat) + latDelta,
  };
}

function s2TrueColourEvalscript() {
  return `//VERSION=3
function setup() {
  return {
    input: ["B02", "B03", "B04", "dataMask"],
    output: { bands: 4, sampleType: "AUTO" }
  };
}
function evaluatePixel(sample) {
  return [2.5 * sample.B04, 2.5 * sample.B03, 2.5 * sample.B02, sample.dataMask];
}`;
}

function s1VvDbEvalscript() {
  return `//VERSION=3
function setup() {
  return {
    input: ["VV", "dataMask"],
    output: { bands: 4, sampleType: "AUTO" }
  };
}
function toDb(linear) {
  return Math.max(0, Math.log(linear) * 0.21714724095 + 1);
}
function evaluatePixel(sample) {
  const v = toDb(sample.VV);
  return [v, v, v, sample.dataMask];
}`;
}

async function fetchCopernicusImage(request, env, ctx) {
  let body;
  try { body = await request.json(); }
  catch (_) { return jsonResponse({ error: 'Request body must be JSON.' }, 400); }

  const mission = String(body?.mission || '').toLowerCase() === 's2' ? 's2' : 's1';
  const lat = Number(body?.lat);
  const lon = Number(body?.lon);
  const observedAt = new Date(body?.observedAt || '');
  const sizeKm = Math.max(5, Math.min(50, Number(body?.sizeKm || 20)));
  const width = Math.max(320, Math.min(768, Math.round(Number(body?.width || 640))));
  const height = Math.max(320, Math.min(768, Math.round(Number(body?.height || 640))));

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return jsonResponse({ error: 'Valid lat and lon are required.' }, 400);
  }
  if (!Number.isFinite(observedAt.getTime())) return jsonResponse({ error: 'A valid observedAt timestamp is required.' }, 400);
  if (!cdseClientId(env) || !cdseClientSecret(env)) {
    return jsonResponse({
      error: 'Copernicus Process API imagery is not configured.',
      detail: 'Create an OAuth client in the Copernicus Data Space Sentinel Hub dashboard, then add COPERNICUS_CLIENT_ID and COPERNICUS_CLIENT_SECRET as Cloudflare Worker secrets.',
      requiredSecrets: ['COPERNICUS_CLIENT_ID', 'COPERNICUS_CLIENT_SECRET'],
    }, 503);
  }

  const bounds = imageryBounds(lat, lon, sizeKm);
  const halfWindowMs = mission === 's2' ? 10 * 60_000 : 5 * 60_000;
  const from = new Date(observedAt.getTime() - halfWindowMs).toISOString();
  const to = new Date(observedAt.getTime() + halfWindowMs).toISOString();
  const type = mission === 's2' ? 'sentinel-2-l2a' : 'sentinel-1-grd';
  const evalscript = mission === 's2' ? s2TrueColourEvalscript() : s1VvDbEvalscript();

  const processBody = {
    input: {
      bounds: {
        bbox: [bounds.west, bounds.south, bounds.east, bounds.north],
        properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' },
      },
      data: [{
        type,
        dataFilter: {
          timeRange: { from, to },
          mosaickingOrder: 'mostRecent',
          ...(mission === 's2' ? { maxCloudCoverage: 100 } : {}),
        },
        ...(mission === 's1' ? { processing: { orthorectify: 'true', backCoeff: 'GAMMA0_TERRAIN' } } : {}),
      }],
    },
    output: {
      width,
      height,
      responses: [{ identifier: 'default', format: { type: 'image/png' } }],
    },
    evalscript,
  };

  const cache = caches.default;
  const cacheUrl = new URL('https://twinstone.internal/copernicus-image');
  cacheUrl.searchParams.set('mission', mission);
  cacheUrl.searchParams.set('t', observedAt.toISOString());
  cacheUrl.searchParams.set('lat', lat.toFixed(4));
  cacheUrl.searchParams.set('lon', lon.toFixed(4));
  cacheUrl.searchParams.set('km', String(sizeKm));
  const cacheKey = new Request(cacheUrl.toString());
  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
    headers.set('X-Twinstone-Cache', 'hit');
    return new Response(cached.body, { status: cached.status, headers });
  }

  const doProcess = async (forceToken = false) => {
    const token = await getCdseToken(env, forceToken);
    return await safeFetch('https://sh.dataspace.copernicus.eu/process/v1', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'image/png',
      },
      body: JSON.stringify(processBody),
    }, 45_000);
  };

  let upstream = await doProcess(false);
  if (upstream.status === 401) {
    cdseToken = null;
    cdseTokenExpiresAt = 0;
    upstream = await doProcess(true);
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    return jsonResponse({
      error: `Copernicus Process API HTTP ${upstream.status}`,
      detail: text.slice(0, 1000),
      mission: mission === 's2' ? 'Sentinel-2' : 'Sentinel-1',
    }, upstream.status >= 500 ? 502 : upstream.status);
  }

  const bytes = await upstream.arrayBuffer();
  const headers = {
    ...corsHeaders(),
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=21600',
    'X-Twinstone-Cache': 'miss',
    'X-Twinstone-Source': 'Copernicus Data Space Sentinel Hub Process API',
  };
  const clientResponse = new Response(bytes.slice(0), { status: 200, headers });
  const cacheResponse = new Response(bytes.slice(0), { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=21600' } });
  if (ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, cacheResponse));
  return clientResponse;
}

async function fetchCopernicusCatalogue(requestUrl, bbox) {
  const missionParam = String(requestUrl.searchParams.get('mission') || 's1').toLowerCase();
  const mission = missionParam === 's2' ? 's2' : 's1';
  const collection = mission === 's2' ? 'sentinel-2-l2a' : 'sentinel-1-grd';
  const days = Math.max(1, Math.min(14, Number(requestUrl.searchParams.get('days') || 7)));
  const limit = Math.max(1, Math.min(30, Number(requestUrl.searchParams.get('limit') || 12)));
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  const u = new URL('https://stac.dataspace.copernicus.eu/v1/search');
  u.searchParams.set('collections', collection);
  u.searchParams.set('bbox', `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`);
  u.searchParams.set('datetime', `${start.toISOString()}/${end.toISOString()}`);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('sortby', '-properties.datetime');

  const response = await safeFetch(u.toString(), { headers: { 'Accept': 'application/geo+json, application/json' } }, 20_000);
  if (!response.ok) throw new Error(`Copernicus STAC HTTP ${response.status}`);
  const data = await response.json();
  return {
    status: 'live',
    provider: 'Copernicus Data Space STAC',
    mission: mission === 's2' ? 'Sentinel-2' : 'Sentinel-1',
    collection,
    transport: 'worker-https',
    fetchedAt: new Date().toISOString(),
    features: Array.isArray(data.features) ? data.features.slice(0, limit) : [],
  };
}


function parseCsvRows(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

function firmsObservedAt(date, hhmm) {
  const raw = String(hhmm ?? '').trim().padStart(4, '0').slice(-4);
  const hh = Number(raw.slice(0, 2)), mm = Number(raw.slice(2, 4));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || hh > 23 || mm > 59) return null;
  const d = new Date(`${date}T${raw.slice(0, 2)}:${raw.slice(2, 4)}:00Z`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function parseFirmsCsv(text, bbox) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(x => String(x).trim().toLowerCase());
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  const required = ['latitude', 'longitude', 'acq_date', 'acq_time'];
  if (required.some(k => idx[k] == null)) throw new Error('FIRMS CSV is missing required columns.');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const lat = Number(r[idx.latitude]), lon = Number(r[idx.longitude]);
    const observedAt = firmsObservedAt(r[idx.acq_date], r[idx.acq_time]);
    if (!inBBox(lat, lon, bbox) || !observedAt) continue;
    out.push({
      lat, lon, observedAt,
      brightnessTi4K: finiteOrNull(r[idx.bright_ti4]),
      brightnessTi5K: finiteOrNull(r[idx.bright_ti5]),
      scanKm: finiteOrNull(r[idx.scan]),
      trackKm: finiteOrNull(r[idx.track]),
      satellite: String(r[idx.satellite] ?? '').trim() || null,
      instrument: String(r[idx.instrument] ?? '').trim() || null,
      confidence: String(r[idx.confidence] ?? '').trim().toLowerCase() || null,
      version: String(r[idx.version] ?? '').trim() || null,
      frpMw: finiteOrNull(r[idx.frp]),
      dayNight: String(r[idx.daynight] ?? '').trim().toUpperCase() || null,
      sourceRow: i,
    });
  }
  return out;
}

function clusterFirmsDetections(points, spatialKm = 1.5, temporalMinutes = 90) {
  if (!points.length) return [];
  const timeMs = temporalMinutes * 60_000;
  const latCellDeg = spatialKm / 111.32;
  const lonCellDeg = spatialKm / 72; // conservative for Ukraine latitudes; haversine is authoritative.
  const parent = points.map((_, i) => i), rank = points.map(() => 0);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a === b) return; if (rank[a] < rank[b]) [a, b] = [b, a]; parent[b] = a; if (rank[a] === rank[b]) rank[a]++; };
  const buckets = new Map();
  const sorted = points.map((p, i) => ({ ...p, _i: i, _t: Date.parse(p.observedAt) })).sort((a, b) => a._t - b._t);
  for (const p of sorted) {
    const tb = Math.floor(p._t / timeMs), y = Math.floor(p.lat / latCellDeg), x = Math.floor(p.lon / lonCellDeg);
    for (let dt = -1; dt <= 1; dt++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const arr = buckets.get(`${tb + dt}:${y + dy}:${x + dx}`) || [];
      for (const q of arr) {
        if (Math.abs(p._t - q._t) > timeMs) continue;
        if (haversineKm(p.lat, p.lon, q.lat, q.lon) <= spatialKm) union(p._i, q._i);
      }
    }
    const key = `${tb}:${y}:${x}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }
  const groups = new Map();
  points.forEach((p, i) => { const root = find(i); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(p); });
  const clusters = [];
  for (const members of groups.values()) {
    const frps = members.map(p => Number(p.frpMw)).filter(Number.isFinite);
    const weights = members.map(p => Math.max(0.1, Number.isFinite(Number(p.frpMw)) ? Number(p.frpMw) : 0.1));
    const wsum = weights.reduce((a, b) => a + b, 0) || members.length;
    const lat = members.reduce((a, p, i) => a + p.lat * weights[i], 0) / wsum;
    const lon = members.reduce((a, p, i) => a + p.lon * weights[i], 0) / wsum;
    const times = members.map(p => Date.parse(p.observedAt)).filter(Number.isFinite).sort((a, b) => a - b);
    const conf = { low: 0, nominal: 0, high: 0, other: 0 };
    for (const p of members) { if (p.confidence === 'l') conf.low++; else if (p.confidence === 'n') conf.nominal++; else if (p.confidence === 'h') conf.high++; else conf.other++; }
    const lats = members.map(p => p.lat), lons = members.map(p => p.lon);
    clusters.push({
      lat, lon,
      startAt: new Date(times[0]).toISOString(), endAt: new Date(times[times.length - 1]).toISOString(),
      detectionCount: members.length,
      totalFrpMw: +frps.reduce((a, b) => a + b, 0).toFixed(2),
      maxFrpMw: frps.length ? +Math.max(...frps).toFixed(2) : null,
      meanFrpMw: frps.length ? +(frps.reduce((a, b) => a + b, 0) / frps.length).toFixed(2) : null,
      maxBrightnessTi4K: Math.max(...members.map(p => Number(p.brightnessTi4K)).filter(Number.isFinite), -Infinity),
      confidenceMix: conf,
      dayCount: members.filter(p => p.dayNight === 'D').length,
      nightCount: members.filter(p => p.dayNight === 'N').length,
      satellites: [...new Set(members.map(p => p.satellite).filter(Boolean))],
      instrument: [...new Set(members.map(p => p.instrument).filter(Boolean))].join(', ') || null,
      regionBbox: [+Math.min(...lons).toFixed(5), +Math.min(...lats).toFixed(5), +Math.max(...lons).toFixed(5), +Math.max(...lats).toFixed(5)],
    });
  }
  const frpVals = clusters.map(c => c.totalFrpMw).filter(Number.isFinite).sort((a, b) => a - b);
  const p90 = frpVals.length ? frpVals[Math.min(frpVals.length - 1, Math.ceil((frpVals.length - 1) * .9))] : null;
  clusters.forEach(c => { c.relativeFrpTier = p90 != null && c.totalFrpMw >= p90 ? 'upper-decile' : 'typical-within-current-query'; });
  return clusters.sort((a, b) => Date.parse(b.endAt) - Date.parse(a.endAt) || (b.totalFrpMw || 0) - (a.totalFrpMw || 0));
}

function selectFirmsClusters(clusters, now = Date.now(), cap = 120) {
  if (clusters.length <= cap) return clusters;
  const recent = clusters.filter(c => now - Date.parse(c.endAt) <= 6 * 60 * 60_000);
  const energetic = [...clusters].sort((a, b) => (b.totalFrpMw || 0) - (a.totalFrpMw || 0)).slice(0, 50);
  const selected = new Map();
  [...recent, ...energetic].forEach(c => selected.set(`${c.startAt}|${c.lat.toFixed(5)}|${c.lon.toFixed(5)}`, c));
  if (selected.size < cap) for (const c of clusters) { selected.set(`${c.startAt}|${c.lat.toFixed(5)}|${c.lon.toFixed(5)}`, c); if (selected.size >= cap) break; }
  return [...selected.values()].slice(0, cap);
}

function firmsClusterObservation(c, rank, totalClusters) {
  const idSeed = `${c.startAt}:${c.endAt}:${c.lat.toFixed(4)}:${c.lon.toFixed(4)}`;
  const observation = makeObservation({
    source: 'NASA FIRMS VIIRS NOAA-20 NRT',
    observationType: `${TW}ThermalAnomalyObservation`,
    entityId: `urn:twinstone:thermal-cluster:${encodeURIComponent(idSeed)}`,
    entityType: `${TW}ThermalAnomalyCluster`,
    observedAt: c.endAt,
    lat: +c.lat.toFixed(6), lon: +c.lon.toFixed(6),
    label: `FIRMS thermal cluster · ${c.detectionCount} detection${c.detectionCount === 1 ? '' : 's'}`,
    sourceRecordId: idSeed,
    attributes: {
      product: 'VIIRS NOAA-20 NRT active fire / thermal anomalies',
      detectionCount: c.detectionCount,
      clusterStartAt: c.startAt,
      clusterEndAt: c.endAt,
      clusterDurationMinutes: +((Date.parse(c.endAt) - Date.parse(c.startAt)) / 60000).toFixed(1),
      totalFrpMw: c.totalFrpMw,
      maxFrpMw: c.maxFrpMw,
      meanFrpMw: c.meanFrpMw,
      maxBrightnessTi4K: Number.isFinite(c.maxBrightnessTi4K) ? +c.maxBrightnessTi4K.toFixed(2) : null,
      sourceConfidenceMix: c.confidenceMix,
      dayDetections: c.dayCount,
      nightDetections: c.nightCount,
      satellites: c.satellites,
      instrument: c.instrument,
      regionBbox: c.regionBbox,
      relativeFrpTier: c.relativeFrpTier,
      clusterRankByRecency: rank + 1,
      sourceClusterCount: totalClusters,
      cause: 'unknown',
      interpretation: 'NASA FIRMS active-fire / thermal-anomaly detections grouped deterministically; this does not establish a strike, explosion, damage, actor, intent or attribution.',
    },
  });
  observation.provenance.method = 'NASA FIRMS area CSV + deterministic 1.5 km / 90 min clustering after low-confidence filtering';
  observation.provenance.sourceDataProduct = 'VIIRS_NOAA20_NRT';
  return observation;
}

async function fetchFirmsThermal(request, env, bbox) {
  const key = secret(env, 'FIRMS_MAP_KEY');
  if (!key) return {
    feed: 'thermal', provider: 'NASA FIRMS VIIRS NOAA-20 NRT', status: 'credential-required', observations: [],
    error: 'FIRMS_MAP_KEY is not configured.', transport: 'worker-https',
    metrics: { rawDetections: 0, eligibleDetections: 0, filteredLowConfidence: 0, clusters: 0, returnedClusters: 0 },
    policy: { source: 'VIIRS_NOAA20_NRT', dayRange: 1, lowConfidence: 'filtered', clusterDistanceKm: 1.5, clusterWindowMinutes: 90, outputCap: 120 },
  };
  const cache = caches.default, origin = new URL(request.url).origin;
  const sig = [bbox.west, bbox.south, bbox.east, bbox.north].map(v => Number(v).toFixed(2)).join('_');
  const freshKey = new Request(`${origin}/__twinstone_cache/firms-v1/${sig}/fresh`), staleKey = new Request(`${origin}/__twinstone_cache/firms-v1/${sig}/stale`);
  const fresh = await readJsonCache(cache, freshKey);
  if (fresh) return { ...fresh, cacheState: 'fresh-cache', upstreamStatus: 'cached', servedAt: new Date().toISOString() };
  const stale = await readJsonCache(cache, staleKey);
  const sourceUrl = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/VIIRS_NOAA20_NRT/${bbox.west},${bbox.south},${bbox.east},${bbox.north}/1`;
  try {
    const r = await safeFetch(sourceUrl, { headers: { 'Accept': 'text/csv', 'User-Agent': `Twinstone/${VERSION} NASA-FIRMS` } }, 20_000);
    const text = await r.text();
    if (!r.ok) { const e = new Error(`NASA FIRMS HTTP ${r.status}: ${text.slice(0, 240)}`); e.status = r.status; throw e; }
    const raw = parseFirmsCsv(text, bbox);
    const low = raw.filter(p => p.confidence === 'l').length;
    const eligible = raw.filter(p => p.confidence !== 'l');
    const clusters = clusterFirmsDetections(eligible, 1.5, 90);
    const selected = selectFirmsClusters(clusters, Date.now(), 120);
    const observations = selected.map((c, i) => firmsClusterObservation(c, i, clusters.length));
    const fetchedAt = new Date().toISOString();
    const payload = {
      feed: 'thermal', provider: 'NASA FIRMS VIIRS NOAA-20 NRT', status: 'live', observations, error: null,
      transport: 'worker-https', cacheState: 'origin', upstreamStatus: 'live', sourceDataFetchedAt: fetchedAt, lastSuccessfulSnapshotAt: fetchedAt,
      nextUpstreamAttemptAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      metrics: { rawDetections: raw.length, eligibleDetections: eligible.length, filteredLowConfidence: low, clusters: clusters.length, returnedClusters: observations.length, upperDecileClusters: clusters.filter(c => c.relativeFrpTier === 'upper-decile').length },
      policy: { source: 'VIIRS_NOAA20_NRT', dayRange: 1, lowConfidence: 'filtered', clusterDistanceKm: 1.5, clusterWindowMinutes: 90, outputCap: 120, selection: 'all when <=120; otherwise recent <=6h plus top FRP and fill by recency' },
    };
    await putJsonCache(cache, freshKey, payload, 15 * 60);
    await putJsonCache(cache, staleKey, payload, 6 * 60 * 60);
    return payload;
  } catch (error) {
    if (stale?.observations?.length) return { ...stale, status: 'fallback', cacheState: 'stale-cache', upstreamStatus: 'degraded', error: safeError(error), servedAt: new Date().toISOString() };
    return { feed: 'thermal', provider: 'NASA FIRMS VIIRS NOAA-20 NRT', status: 'degraded', observations: [], error: safeError(error), transport: 'worker-https', metrics: { rawDetections: 0, eligibleDetections: 0, filteredLowConfidence: 0, clusters: 0, returnedClusters: 0 }, policy: { source: 'VIIRS_NOAA20_NRT', dayRange: 1, lowConfidence: 'filtered', clusterDistanceKm: 1.5, clusterWindowMinutes: 90, outputCap: 120 } };
  }
}


function ucdpViolenceLabel(v) {
  const n = Number(v);
  return n === 1 ? 'state-based' : n === 2 ? 'non-state' : n === 3 ? 'one-sided' : 'unknown';
}

function isoDateOnly(v) {
  const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function ucdpEventObservation(row, version) {
  const lat = Number(row?.latitude), lon = Number(row?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const endDate = isoDateOnly(row?.date_end || row?.date_start);
  if (!endDate) return null;
  // UCDP GED is normally date-granular rather than time-of-day granular.
  // Midnight UTC is a storage/order convention only; attributes explicitly
  // preserve the date precision so the browser does not infer an exact time.
  const observedAt = `${endDate}T00:00:00.000Z`;
  const id = String(row?.id ?? row?.relid ?? `${lat}:${lon}:${endDate}`);
  const event = makeObservation({
    source: 'UCDP Candidate Events',
    observationType: `${TW}ReportedConflictEvent`,
    entityId: `urn:twinstone:ucdp:event:${encodeURIComponent(id)}`,
    entityType: `${TW}ReportedConflictEvent`,
    observedAt,
    lat, lon,
    label: `UCDP reported event ${id}`,
    sourceRecordId: id,
    attributes: {
      dataset: 'UCDP Candidate Events',
      ucdpApiVersion: version,
      ucdpEventId: row?.id ?? null,
      relid: row?.relid ?? null,
      codeStatus: row?.code_status ?? null,
      eventClarity: row?.event_clarity ?? null,
      typeOfViolenceCode: Number.isFinite(Number(row?.type_of_violence)) ? Number(row.type_of_violence) : null,
      typeOfViolence: ucdpViolenceLabel(row?.type_of_violence),
      conflictId: row?.conflict_new_id ?? row?.conflict_dset_id ?? null,
      conflictName: row?.conflict_name ?? null,
      dyadId: row?.dyad_new_id ?? row?.dyad_dset_id ?? null,
      dyadName: row?.dyad_name ?? null,
      sideA: row?.side_a ?? row?.side_a_name ?? null,
      sideB: row?.side_b ?? row?.side_b_name ?? null,
      country: row?.country ?? null,
      countryId: row?.country_id ?? null,
      region: row?.region ?? null,
      dateStart: isoDateOnly(row?.date_start),
      dateEnd: endDate,
      datePrecisionCode: Number.isFinite(Number(row?.date_prec)) ? Number(row.date_prec) : null,
      timeOfDayKnown: false,
      geoPrecisionCode: Number.isFinite(Number(row?.where_prec ?? row?.geo_prec)) ? Number(row?.where_prec ?? row?.geo_prec) : null,
      locationDescription: row?.where_description ?? row?.adm_1 ?? null,
      fatalitiesBest: Number.isFinite(Number(row?.best)) ? Number(row.best) : null,
      fatalitiesLow: Number.isFinite(Number(row?.low)) ? Number(row.low) : null,
      fatalitiesHigh: Number.isFinite(Number(row?.high)) ? Number(row.high) : null,
      deathsCivilians: Number.isFinite(Number(row?.deaths_civilians)) ? Number(row.deaths_civilians) : null,
      reportingNature: 'UCDP-coded reported event; not a physical sensor observation',
      interpretation: 'A versioned UCDP Candidate GED event. It can be spatially/temporally associated with other supplied evidence but does not prove the cause of a FIRMS anomaly or Sentinel change.',
    },
  });
  event.provenance.method = 'UCDP Candidate GED API filtered by Geography + StartDate + EndDate';
  event.provenance.sourceDataVersion = version;
  event.provenance.sourceUrl = `https://ucdpapi.pcr.uu.se/api/gedevents/${encodeURIComponent(version)}`;
  return event;
}

async function fetchUcdpReportedEvents(request, env, bbox) {
  const token = secret(env, 'UCDP_ACCESS_TOKEN');
  const version = secret(env, 'UCDP_API_VERSION') || UCDP_API_VERSION;
  const basePolicy = { resource: 'gedevents', dataset: 'UCDP Candidate Events', apiVersion: version, lookbackDays: UCDP_LOOKBACK_DAYS, pageSize: 200, pageCap: 5, outputCap: 500, dateSemantics: 'date-only; time of day not inferred' };
  if (!token) return {
    feed: 'reportedConflict', provider: 'UCDP Candidate Events', status: 'credential-required', observations: [],
    error: 'UCDP_ACCESS_TOKEN is not configured yet. The adapter is ready and will activate after the token is added.', transport: 'worker-https',
    metrics: { totalMatches: 0, pagesFetched: 0, returnedEvents: 0, truncated: false }, policy: basePolicy,
  };

  const cache = caches.default, origin = new URL(request.url).origin;
  const sig = [bbox.west, bbox.south, bbox.east, bbox.north].map(v => Number(v).toFixed(2)).join('_');
  const freshKey = new Request(`${origin}/__twinstone_cache/ucdp-v1/${encodeURIComponent(version)}/${sig}/fresh`);
  const staleKey = new Request(`${origin}/__twinstone_cache/ucdp-v1/${encodeURIComponent(version)}/${sig}/stale`);
  const fresh = await readJsonCache(cache, freshKey);
  if (fresh) return { ...fresh, cacheState: 'fresh-cache', upstreamStatus: 'cached', servedAt: new Date().toISOString() };
  const stale = await readJsonCache(cache, staleKey);

  const end = new Date();
  const start = new Date(end.getTime() - UCDP_LOOKBACK_DAYS * 86400000);
  const date = x => x.toISOString().slice(0,10);
  const common = new URLSearchParams({
    pagesize: '200',
    Geography: `${bbox.south} ${bbox.west},${bbox.north} ${bbox.east}`,
    StartDate: date(start),
    EndDate: date(end),
  });

  try {
    const rows = [];
    let totalMatches = 0, totalPages = 1, pagesFetched = 0;
    for (let page = 1; page <= Math.min(totalPages, 5) && rows.length < 1000; page++) {
      const q = new URLSearchParams(common);
      q.set('page', String(page));
      const sourceUrl = `https://ucdpapi.pcr.uu.se/api/gedevents/${encodeURIComponent(version)}?${q.toString()}`;
      const r = await safeFetch(sourceUrl, { headers: { 'Accept': 'application/json', 'x-ucdp-access-token': token, 'User-Agent': `Twinstone/${VERSION} UCDP` } }, 20_000);
      const text = await r.text();
      if (!r.ok) { const e = new Error(`UCDP HTTP ${r.status}: ${text.slice(0,240)}`); e.status = r.status; throw e; }
      const data = JSON.parse(text);
      const batch = Array.isArray(data?.Result) ? data.Result : [];
      totalMatches = Number(data?.TotalCount || batch.length || 0);
      totalPages = Math.max(1, Number(data?.TotalPages || 1));
      rows.push(...batch);
      pagesFetched++;
    }
    const sortedRows = rows.slice().sort((a,b) => String(b?.date_end || b?.date_start || '').localeCompare(String(a?.date_end || a?.date_start || '')));
    const observations = sortedRows.slice(0,500).map(r => ucdpEventObservation(r, version)).filter(Boolean);
    const fetchedAt = new Date().toISOString();
    const payload = {
      feed: 'reportedConflict', provider: 'UCDP Candidate Events', status: 'live', observations, error: null,
      transport: 'worker-https', cacheState: 'origin', upstreamStatus: 'live', sourceDataFetchedAt: fetchedAt, lastSuccessfulSnapshotAt: fetchedAt,
      nextUpstreamAttemptAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      metrics: { totalMatches, pagesFetched, returnedEvents: observations.length, truncated: totalMatches > rows.length || rows.length > 500 },
      policy: { ...basePolicy, startDate: date(start), endDate: date(end), geography: `${bbox.south} ${bbox.west},${bbox.north} ${bbox.east}` },
    };
    await putJsonCache(cache, freshKey, payload, 30 * 60);
    await putJsonCache(cache, staleKey, payload, 24 * 60 * 60);
    return payload;
  } catch (error) {
    if (stale?.observations?.length) return { ...stale, status: 'fallback', cacheState: 'stale-cache', upstreamStatus: 'degraded', error: safeError(error), servedAt: new Date().toISOString() };
    return { feed: 'reportedConflict', provider: 'UCDP Candidate Events', status: 'degraded', observations: [], error: safeError(error), transport: 'worker-https', metrics: { totalMatches: 0, pagesFetched: 0, returnedEvents: 0, truncated: false }, policy: basePolicy };
  }
}

async function fetchWeather(bbox, areaName = 'Operational area', profile = 'area') {
  const c = bboxCenter(bbox);
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.searchParams.set('latitude', c.lat.toFixed(4));
  u.searchParams.set('longitude', c.lon.toFixed(4));
  u.searchParams.set('current', 'temperature_2m,wind_speed_10m,wind_direction_10m,visibility,weather_code');
  u.searchParams.set('wind_speed_unit', 'kn');
  u.searchParams.set('temperature_unit', 'celsius');
  u.searchParams.set('timezone', 'UTC');

  const response = await safeFetch(u.toString(), { headers: { 'Accept': 'application/json' } }, 10_000);
  if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
  const data = await response.json();
  const current = data.current || {};

  const observation = makeObservation({
    source: 'Open-Meteo',
    observationType: `${TW}WeatherObservationEvent`,
    entityId: `urn:twinstone:weather:${profile}`,
    entityType: `${TW}WeatherArea`,
    observedAt: current.time ? new Date(`${current.time}Z`).toISOString() : new Date().toISOString(),
    lat: c.lat,
    lon: c.lon,
    label: `${areaName} weather`,
    kinematics: {},
    attributes: {
      temperatureC: finiteOrNull(current.temperature_2m),
      windSpeedKts: finiteOrNull(current.wind_speed_10m),
      windDirectionDeg: finiteOrNull(current.wind_direction_10m),
      visibilityKm: Number.isFinite(Number(current.visibility)) ? Number((Number(current.visibility) / 1000).toFixed(1)) : null,
      weatherCode: finiteOrNull(current.weather_code),
    },
  });

  return { feed: 'weather', provider: 'Open-Meteo', status: 'live', observations: [observation], sourceDataFetchedAt: new Date().toISOString(), lastUpstreamAttemptAt: new Date().toISOString(), transport: 'worker-https' };
}

async function fetchEarthquakes(bbox, globalOverview = false) {
  const response = await safeFetch(
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    { headers: { 'Accept': 'application/geo+json, application/json' } },
    10_000,
  );
  if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
  const data = await response.json();

  const observations = (data.features || []).map(f => {
    const coords = f.geometry?.coordinates || [];
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!globalOverview && !inBBox(lat, lon, bbox)) return null;

    const p = f.properties || {};
    return makeObservation({
      source: 'USGS',
      observationType: `${TW}EarthquakeEvent`,
      entityId: `urn:twinstone:earthquake:${f.id || crypto.randomUUID()}`,
      entityType: `${TW}EarthquakeEvent`,
      observedAt: Number.isFinite(Number(p.time)) ? new Date(Number(p.time)).toISOString() : new Date().toISOString(),
      lat,
      lon,
      label: p.place || `M${p.mag || '?'} earthquake`,
      sourceRecordId: f.id || '',
      attributes: {
        magnitude: finiteOrNull(p.mag),
        depthKm: Number.isFinite(Number(coords[2])) ? Number(coords[2]) : null,
        place: p.place || null,
        alert: p.alert || null,
        significance: finiteOrNull(p.sig),
        url: p.url || null,
      },
    });
  }).filter(Boolean);

  return { feed: 'earthquakes', provider: 'USGS', status: 'live', observations, sourceDataFetchedAt: new Date().toISOString(), lastUpstreamAttemptAt: new Date().toISOString(), transport: 'worker-https', policy: { product: '2.5_day.geojson', feedWindowHours: 24, minimumMagnitude: 2.5 } };
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function handleAISWebSocket(request, env, url) {
  const upgrade = request.headers.get('Upgrade');
  if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  const apiKey = secret(env, 'AISSTREAM_API_KEY', 'AIS_API_KEY');
  if (!apiKey) {
    return new Response('AISStream secret is not configured', { status: 503 });
  }

  const bbox = parseBBox(url);
  const [client, browserSocket] = Object.values(new WebSocketPair());
  browserSocket.accept({ allowHalfOpen: true });

  let upstream;
  let rawFrames = 0;
  let positionFrames = 0;
  let lastFrameAt = null;

  try {
    upstream = new WebSocket('wss://stream.aisstream.io/v0/stream');
  } catch (error) {
    browserSocket.send(JSON.stringify({ type: 'status', source: 'aisstream', status: 'error', error: safeError(error) }));
    browserSocket.close(1011, 'AIS upstream connection failed');
    return new Response(null, { status: 101, webSocket: client });
  }

  upstream.addEventListener('open', () => {
    // Deliberately do not apply FilterMessageTypes in the baseline. This removes
    // message-filter compatibility as a possible cause of a silent stream.
    const subscription = {
      APIKey: apiKey,
      BoundingBoxes: [[[bbox.south, bbox.west], [bbox.north, bbox.east]]],
    };
    upstream.send(JSON.stringify(subscription));
    safeSocketSend(browserSocket, {
      type: 'status', source: 'aisstream', status: 'subscribed',
      message: 'Upstream WebSocket connected and subscription sent.',
      rawFrames, positionFrames,
    });
  });

  upstream.addEventListener('message', event => {
    rawFrames++;
    lastFrameAt = new Date().toISOString();
    try {
      const raw = JSON.parse(String(event.data));
      const upstreamError = raw?.error || raw?.Error || raw?.message || raw?.MessageText;
      if (upstreamError && !raw?.MessageType) {
        safeSocketSend(browserSocket, {
          type: 'status', source: 'aisstream', status: 'error',
          error: String(upstreamError).slice(0, 300), rawFrames, positionFrames, lastFrameAt,
        });
        return;
      }

      const observation = normalizeAIS(raw, bbox);
      if (observation) {
        positionFrames++;
        safeSocketSend(browserSocket, { type: 'observation', observation });
      }

      if (rawFrames === 1 || rawFrames % 100 === 0) {
        safeSocketSend(browserSocket, {
          type: 'status', source: 'aisstream',
          status: positionFrames ? 'live' : 'receiving',
          message: positionFrames ? 'AIS frames and vessel positions are arriving.' : 'AIS frames are arriving, but no position report has normalised yet.',
          rawFrames, positionFrames, lastFrameAt,
        });
      }
    } catch (error) {
      safeSocketSend(browserSocket, {
        type: 'status', source: 'aisstream', status: 'warning', error: safeError(error),
        rawFrames, positionFrames, lastFrameAt,
      });
    }
  });

  upstream.addEventListener('error', () => {
    safeSocketSend(browserSocket, {
      type: 'status', source: 'aisstream', status: 'error',
      error: 'AISStream upstream WebSocket error', rawFrames, positionFrames, lastFrameAt,
    });
  });

  upstream.addEventListener('close', event => {
    safeSocketSend(browserSocket, {
      type: 'status', source: 'aisstream', status: 'closed', code: event.code,
      reason: event.reason || '', rawFrames, positionFrames, lastFrameAt,
    });
    try { browserSocket.close(event.code || 1000, event.reason || 'AISStream closed'); } catch (_) {}
  });

  browserSocket.addEventListener('close', () => {
    try { upstream.close(1000, 'Browser disconnected'); } catch (_) {}
  });

  browserSocket.addEventListener('error', () => {
    try { upstream.close(1011, 'Browser socket error'); } catch (_) {}
  });

  return new Response(null, { status: 101, webSocket: client });
}

function normalizeAIS(raw, bbox) {
  const type = raw?.MessageType;
  const payload = raw?.Message?.[type];
  if (!type || !payload) return null;

  const lat = firstFinite(payload.Latitude, payload.latitude, raw?.MetaData?.latitude, raw?.MetaData?.Latitude);
  const lon = firstFinite(payload.Longitude, payload.longitude, raw?.MetaData?.longitude, raw?.MetaData?.Longitude);
  if (!inBBox(lat, lon, bbox)) return null;

  const mmsi = String(
    payload.UserID ?? payload.UserId ?? payload.MMSI ?? raw?.MetaData?.MMSI ?? raw?.MetaData?.Mmsi ?? ''
  ).trim();
  if (!mmsi) return null;

  const shipName = String(raw?.MetaData?.ShipName || raw?.MetaData?.shipName || '').trim();
  const cog = firstFinite(payload.Cog, payload.COG, payload.CourseOverGround);
  const sog = firstFinite(payload.Sog, payload.SOG, payload.SpeedOverGround);
  const heading = firstFinite(payload.TrueHeading, payload.Heading);
  const timestamp = raw?.MetaData?.time_utc || raw?.MetaData?.TimeUtc || new Date().toISOString();

  return makeObservation({
    source: 'AISStream',
    observationType: `${TW}VesselPositionObservation`,
    entityId: `urn:twinstone:ship:mmsi:${mmsi}`,
    entityType: `${IES}Ship`,
    observedAt: toIsoSafe(timestamp),
    lat,
    lon,
    label: shipName || `MMSI ${mmsi}`,
    sourceRecordId: mmsi,
    kinematics: {
      speedKts: sog,
      headingDeg: heading,
      courseDeg: cog,
    },
    attributes: {
      mmsi,
      shipName: shipName || null,
      aisMessageType: type,
      navigationalStatus: payload.NavigationalStatus ?? null,
      rateOfTurn: finiteOrNull(payload.RateOfTurn),
    },
  });
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function toIsoSafe(value) {
  try {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  } catch (_) {}
  return new Date().toISOString();
}

function safeSocketSend(socket, obj) {
  try {
    if (socket.readyState === 1) socket.send(JSON.stringify(obj));
  } catch (_) {}
}

function isTransientAgentStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function parseUpstreamError(text) {
  try {
    const data = JSON.parse(text);
    const e = data?.error || data || {};
    return {
      message: typeof e.message === 'string' ? e.message : '',
      code: e.code ?? null,
      status: typeof e.status === 'string' ? e.status : '',
    };
  } catch (_) {
    return { message: String(text || '').slice(0, 300), code: null, status: '' };
  }
}

function retryAfterMilliseconds(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.round(seconds * 1000));
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, Math.min(60_000, when - Date.now()));
  return null;
}

async function handleGeminiQuery(request, env) {
  const apiKey = secret(env, 'GEMINI_API_KEY', 'GOOGLE_API_KEY');
  if (!apiKey) return jsonResponse({ error: 'GEMINI_API_KEY secret is not configured.' }, 503);

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ error: 'Request body must be JSON.' }, 400);
  }

  const question = String(body.question || '').trim();
  if (!question) return jsonResponse({ error: 'question is required.' }, 400);

  const incoming = Array.isArray(body.observations) ? body.observations : [];
  const allObservations = incoming.slice(0, 800).map(compactObservation);
  const health = body.health && typeof body.health === 'object' ? body.health : {};

  // Twinstone deliberately performs simple numeric operations deterministically.
  // The language model interprets and explains those results; it is not asked to
  // sort hundreds of raw records to discover a maximum/minimum itself.
  const deterministicEvidence = buildDeterministicEvidence(question, allObservations);
  const observations = deterministicEvidence.applied
    ? deterministicEvidence.records
    : allObservations;

  const sourceSummary = summarizeForModel(allObservations);
  const contextSummary = summarizeContext(allObservations);

  const systemInstruction = [
    'You are the Twinstone analysis agent interrogating a fused open-source operational picture.',
    'The supplied records are observations, not guaranteed ground truth. They use a Twinstone envelope aligned to IES4 concepts.',
    'Use only the supplied records, deterministic evidence, context summary, and feed-health metadata for factual claims. Never invent missing telemetry, identities, intent, destinations, affiliations, or classifications.',
    'Twinstone may provide deterministicEvidence for numeric operations and broad summaries. When deterministicEvidence.applied is true, its counts, summary fields, candidate count, ordering and result records are authoritative for that operation. Do not independently re-rank or enumerate the full dataset.',
    'When deterministicEvidence.intent is summary, produce a readable synthesis rather than echoing raw coordinates or timestamps. Lead with the deterministic counts and metrics, then explain the strongest supplied evidence, associations and limitations. Never answer a summary request with only an identifier, coordinate, timestamp or source-record fragment.',
    'For a simple lookup, ranking, count or superlative question, answer the question directly and concisely first. Return only the requested entity or small requested result set unless the user explicitly asks for more.',
    'For broad operational-picture questions, separate the answer into: Observed facts; Derived estimates; Assessment; Data gaps / confidence.',
    'For important claims, cite the evidence inline using [SOURCE | ENTITY | TIME].',
    'Counts and thresholds must be based on provided numeric fields. distanceToDoverKm is precomputed deterministically.',
    'Satellite records are position estimates propagated by Twinstone with SGP4 from CelesTrak GP/OMM orbital elements. They are not direct sensor observations. When relevant, distinguish the propagated position time from the source element epoch and do not describe a propagated estimate as a direct observation.',
    'Copernicus Sentinel STAC records are catalogue/coverage metadata, not observations of ground conditions. For broad operational-picture questions, place them under EO coverage or data availability rather than under observed ground facts. If imageryAvailable is true it only means a human can inspect a quicklook or processed render; unless explicit image-analysis results are separately supplied, never infer damage, strikes, unit locations, intent, or military activity from catalogue metadata or imagery availability alone.',
    'Twinstone EarthObservationChangeDetection records are explicit deterministic image-analysis results derived from a paired Sentinel comparison. Treat them as derived estimates, not observed ground facts. They support claims that sensor values changed within a stated region between the two supplied acquisition times, with the stated method and comparison quality. They do not identify the cause, object type, actor, intent, strike, damage mechanism, unit, or attribution unless an independent supplied source separately supports that claim. Preserve cause=unknown when present.',
    'NASA FIRMS records are active-fire / thermal-anomaly detections. Twinstone may deterministically cluster nearby detections and summarize FRP, brightness, time, confidence mix and spatial extent. Do not describe a FIRMS cluster as an attack, explosion, strike, damage site or military event. FIRMS itself explicitly includes non-fire thermal anomalies and persistent hot sources. Preserve cause=unknown unless an independent supplied source supports a narrower explanation.',
    'UCDP ReportedConflictEvent records are versioned, coded reports of organized-violence events from UCDP Candidate GED. They are not physical sensor observations. Preserve UCDP date/geographic precision and fatality uncertainty; do not present a date-only event as having a known time of day. A nearby FIRMS anomaly or EO change may be associated in space/time but is not thereby proven to have the same cause.',
    'Global Fishing Watch MaritimeActivityObservation records are AIS-derived algorithmic activity events, not live vessel-position telemetry. Preserve event type and source caveats. Apparent fishing is not independently confirmed fishing; encounter does not establish transshipment; loitering does not establish an encounter or intent; a port visit is AIS-derived rather than direct port-authority confirmation; AIS-gap data are prototype-quality and do not independently establish deliberate disabling, cause or intent.',
    'Twinstone CrossSourceAssociation records are deterministic spatial/temporal proximity relationships between supplied observations. They are not causal evidence. A spatiotemporal association may justify saying that two observations are near each other in space/time, but not that one caused the other or that they have a common cause.',
    'Twinstone MultiSourceEvidenceChain records are deterministic closed chains linking a UCDP reported event, a FIRMS thermal cluster and an EO-change region that each pass the stated pairwise spatial/temporal rules. A three-source chain increases corroboration of co-located activity, but it still does not prove common cause, strike, damage, actor, intent or attribution.',
    'Twinstone CorroborationAreaObservation records are deterministic, coarse 20 km analysis cells used as an analyst attention aid. Their 0-100 score is computed before the language model from five transparent factors: independent evidence classes (30), recency (25), spatial coherence (20), temporal coherence (15), and evidence quality (10). A high score means stronger corroborative evidence within the selected time window; it is not a target, threat, military-significance, intent, attribution, or future-activity ranking. Explain the factor scores when discussing a watchlist area.',
    'Provenance.transport records whether Twinstone acquired a source through browser-https or worker-https. Treat transport as provenance/assurance metadata, not as evidence about the observed event itself.',
    'Each observation may contain a temporal object with status current, ageing, or stale plus ageSeconds. Treat this as authoritative metadata supplied by Twinstone.',
    'Current observations may be described as current. Ageing observations remain usable with caution. Stale observations are last-known evidence only and must not be described as a current position or current state.',
    'Feed-health metadata may distinguish latest-fetch counts from the larger temporally retained context. Do not interpret an entity missing from the latest fetch as having disappeared.',
    'When replayAt is supplied, the browser has deterministically filtered the evidence package to that replay cutoff. Describe the picture as evidence available by that time and do not imply access to later observations.',
    'analystNotebook, when supplied, is analyst-authored working material. It may contain notes, an assessment, unknowns/gaps and stable evidence references. Never treat notebook prose as independent source evidence, never use it to increase corroboration, and label it explicitly as analyst-authored when relying on it for context.',
    'deterministicInvestigationAssessment, when supplied, is authoritative for its stated five-factor score. The score is an evidence-quality/analyst-attention aid, not a probability, threat score, targeting priority, prediction, or causal conclusion. Explain its factor deficits rather than inventing confidence percentages.',
    'deterministicChangeSummary, when supplied, compares retained/searchable evidence in the current window with the immediately previous equivalent window. Its coverageComplete and partialSources fields are authoritative. Never interpret missing historical source coverage as zero real-world activity, and never treat a count delta by itself as proof that real-world activity increased or decreased.',
    'investigationContext contains non-map contextual sources such as IODA connectivity events, NOAA SWPC space weather, ReliefWeb humanitarian reporting and WHO Disease Outbreak News. Treat these as context/reporting with their supplied scope and caveats. They do not automatically increase corroboration scores, do not turn temporal/spatial coincidence into causation, and must not be described as physical observations unless the source itself is a physical measurement.',
    'If a source is failed, absent, stale, degraded, or running on fallback, state that limitation when relevant to the answer.',
    'A lack of observations does not prove a lack of real-world activity.',
    'Be concise but analytical.',
  ].join(' ');

  const investigationContext = body.investigationContext && typeof body.investigationContext === 'object' ? body.investigationContext : null;

  const prompt = {
    question,
    pictureGeneratedAt: body.generatedAt || new Date().toISOString(),
    operationalProfile: body.profile || null,
    area: body.area || null,
    investigation: body.investigation || null,
    analysisWindowHours: body.analysisWindowHours || null,
    replayAt: body.replayAt || null,
    analystNotebook: body.analystNotebook || null,
    deterministicInvestigationAssessment: body.deterministicInvestigationAssessment || null,
    deterministicChangeSummary: body.deterministicChangeSummary || null,
    investigationContext,
    feedHealth: health,
    contextSummary,
    sourceSummary,
    deterministicEvidence,
    observations,
  };

  let response;
  try {
    response = await safeFetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(prompt) }] }],
          generationConfig: { maxOutputTokens: 1200 },
        }),
      },
      30_000,
    );
  } catch (error) {
    return jsonResponse({
      error: 'Agent temporarily unavailable',
      message: safeError(error),
      retryable: true,
      upstreamStatus: 504,
      upstreamCode: null,
      upstreamState: 'TIMEOUT_OR_NETWORK_ERROR',
      retryAfterMs: 1000,
    }, 503);
  }

  const text = await response.text();
  if (!response.ok) {
    const retryable = isTransientAgentStatus(response.status);
    const upstream = parseUpstreamError(text);
    const retryAfterMs = retryAfterMilliseconds(response.headers.get('Retry-After'));
    return jsonResponse({
      error: retryable ? 'Agent temporarily unavailable' : 'Agent request failed',
      message: upstream.message || `Gemini returned HTTP ${response.status}.`,
      retryable,
      upstreamStatus: response.status,
      upstreamCode: upstream.code || null,
      upstreamState: upstream.status || null,
      retryAfterMs: retryable ? (retryAfterMs || 1000) : null,
    }, retryable ? 503 : 502);
  }

  let data;
  try { data = JSON.parse(text); }
  catch (_) { return jsonResponse({ error: 'Agent returned an invalid response envelope.', retryable: true, upstreamStatus: 502, retryAfterMs: 1000 }, 503); }

  const answer = (data.candidates || [])
    .flatMap(c => c?.content?.parts || [])
    .map(p => p?.text || '')
    .filter(Boolean)
    .join('\n')
    .trim();

  const answerValid = usefulAgentAnswer(answer, deterministicEvidence);
  const fallbackAnswer = answerValid ? null : deterministicFallbackAnswer(deterministicEvidence);
  const finalAnswer = answerValid ? answer : (fallbackAnswer || answer || 'Agent returned no usable text response.');

  return jsonResponse({
    model: GEMINI_MODEL,
    agent: { provider: 'Google', name: 'Gemini 3.6 Flash', model: GEMINI_MODEL },
    answer: finalAnswer,
    responseMode: answerValid ? 'agent' : (fallbackAnswer ? 'deterministic-fallback' : 'agent-unusable'),
    observationCount: allObservations.length,
    agentObservationCount: observations.length,
    deterministicEvidence: deterministicEvidence.applied ? {
      applied: true,
      intent: deterministicEvidence.intent,
      domain: deterministicEvidence.domain,
      metric: deterministicEvidence.metric,
      direction: deterministicEvidence.direction,
      temporalScope: deterministicEvidence.temporalScope,
      candidateCount: deterministicEvidence.candidateCount,
      resultCount: deterministicEvidence.records.length,
      summary: deterministicEvidence.intent === 'summary' ? deterministicEvidence.summary : undefined,
    } : { applied: false },
    sourceSummary,
  });
}

function compactObservation(o) {
  return {
    id: o?.['@id'] || null,
    type: o?.['@type'] || null,
    entityId: o?.entity?.['@id'] || null,
    entityType: o?.entity?.['@type'] || null,
    label: o?.entity?.label || null,
    observedAt: o?.observedAt || null,
    location: o?.location || null,
    kinematics: o?.kinematics || {},
    attributes: o?.attributes || {},
    derived: o?.derived || {},
    temporal: o?.temporal || null,
    source: o?.provenance?.source || null,
    provenance: {
      source: o?.provenance?.source || null,
      sourceRecordId: o?.provenance?.sourceRecordId || null,
      ingestedAt: o?.provenance?.ingestedAt || null,
      sourceDataEpoch: o?.provenance?.sourceDataEpoch || null,
      sourceDataProduct: o?.provenance?.sourceDataProduct || null,
      sourceDataVersion: o?.provenance?.sourceDataVersion || null,
      method: o?.provenance?.method || null,
      transport: o?.provenance?.transport || null,
      sourceUrl: o?.provenance?.sourceUrl || null,
    },
  };
}

function observationDomainForQuery(o) {
  const et = String(o?.entityType || '');
  const ot = String(o?.type || '');
  if (et.endsWith('#Aircraft') || et.endsWith('/Aircraft')) return 'aircraft';
  if (ot.endsWith('#MaritimeActivityObservation')) return 'maritimeActivity';
  if (et.endsWith('#Ship') || et.endsWith('/Ship')) return 'vessels';
  if (et.endsWith('#Satellite') || et.endsWith('/Satellite')) return 'satellites';
  if (ot.endsWith('#WeatherObservationEvent')) return 'weather';
  if (ot.endsWith('#EarthquakeEvent')) return 'earthquakes';
  if (ot.endsWith('#ThermalAnomalyObservation') || et.endsWith('#ThermalAnomalyCluster')) return 'thermal';
  if (ot.endsWith('#ReportedConflictEvent') || et.endsWith('#ReportedConflictEvent')) return 'reportedConflict';
  if (ot.endsWith('#MultiSourceEvidenceChain') || et.endsWith('#MultiSourceEvidenceChain')) return 'evidenceChain';
  if (ot.endsWith('#CorroborationAreaObservation') || et.endsWith('#CorroborationArea')) return 'corroborationArea';
  if (ot.endsWith('#CrossSourceAssociation') || et.endsWith('#CrossSourceAssociation')) return 'crossSourceAssociation';
  if (ot.endsWith('#EarthObservationChangeDetection') || et.endsWith('#EarthObservationChangeRegion')) return 'earthObservationChange';
  if (ot.endsWith('#EarthObservationAcquisition') || et.endsWith('#EarthObservationProduct')) return 'earthObservation';
  return 'other';
}

function summarizeContext(observations) {
  const out = { total: observations.length, domains: {}, temporal: { current: 0, ageing: 0, stale: 0, unknown: 0 } };
  for (const o of observations) {
    const d = observationDomainForQuery(o);
    out.domains[d] = (out.domains[d] || 0) + 1;
    const t = o?.temporal?.status;
    if (t === 'current' || t === 'ageing' || t === 'stale') out.temporal[t]++;
    else out.temporal.unknown++;
  }
  return out;
}

function numericPath(o, path) {
  const parts = path.split('.');
  let v = o;
  for (const p of parts) v = v?.[p];
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function queryResultRecord(o) {
  return {
    id: o.id,
    entityId: o.entityId,
    entityType: o.entityType,
    label: o.label,
    observedAt: o.observedAt,
    source: o.source,
    temporal: o.temporal,
    location: o.location,
    kinematics: o.kinematics,
    attributes: {
      icao24: o.attributes?.icao24 ?? null,
      callsign: o.attributes?.callsign ?? null,
      registration: o.attributes?.registration ?? null,
      aircraftType: o.attributes?.aircraftType ?? null,
      mmsi: o.attributes?.mmsi ?? null,
      vesselType: o.attributes?.vesselType ?? null,
      maritimeActivityType: o.attributes?.maritimeActivityType ?? null,
      activityStartAt: o.attributes?.activityStartAt ?? null,
      activityEndAt: o.attributes?.activityEndAt ?? null,
      gfwVesselId: o.attributes?.gfwVesselId ?? null,
      vesselName: o.attributes?.vesselName ?? null,
      flag: o.attributes?.flag ?? null,
      encounteredVessel: o.attributes?.encounteredVessel ?? null,
      portVisitConfidence: o.attributes?.portVisitConfidence ?? null,
      algorithmicNature: o.attributes?.algorithmicNature ?? null,
      noradCatalogId: o.attributes?.noradCatalogId ?? null,
      objectId: o.attributes?.objectId ?? null,
      orbitRegime: o.attributes?.orbitRegime ?? null,
      elementEpoch: o.attributes?.elementEpoch ?? null,
      positionNature: o.attributes?.positionNature ?? null,
      mission: o.attributes?.mission ?? null,
      collection: o.attributes?.collection ?? null,
      cloudCoverPct: o.attributes?.cloudCoverPct ?? null,
      orbitState: o.attributes?.orbitState ?? null,
      productType: o.attributes?.productType ?? null,
      detectionCount: o.attributes?.detectionCount ?? null,
      totalFrpMw: o.attributes?.totalFrpMw ?? null,
      maxFrpMw: o.attributes?.maxFrpMw ?? null,
      relativeFrpTier: o.attributes?.relativeFrpTier ?? null,
      sourceConfidenceMix: o.attributes?.sourceConfidenceMix ?? null,
      cause: o.attributes?.cause ?? null,
      spatialDistanceKm: o.attributes?.spatialDistanceKm ?? null,
      temporalRelation: o.attributes?.temporalRelation ?? null,
      associationType: o.attributes?.associationType ?? null,
      regionAreaKm2: o.attributes?.regionAreaKm2 ?? null,
      totalChangedAreaKm2: o.attributes?.totalChangedAreaKm2 ?? null,
      changedScreeningPct: o.attributes?.changedScreeningPct ?? null,
      comparisonQuality: o.attributes?.comparisonQuality ?? null,
      intervalHours: o.attributes?.intervalHours ?? null,
      eoChangeLocation: o.attributes?.eoChangeLocation ?? null,
      currentAcquiredAt: o.attributes?.currentAcquiredAt ?? null,
      previousAcquiredAt: o.attributes?.previousAcquiredAt ?? null,
      dataset: o.attributes?.dataset ?? null,
      ucdpApiVersion: o.attributes?.ucdpApiVersion ?? null,
      ucdpEventId: o.attributes?.ucdpEventId ?? null,
      typeOfViolence: o.attributes?.typeOfViolence ?? null,
      conflictName: o.attributes?.conflictName ?? null,
      dyadName: o.attributes?.dyadName ?? null,
      country: o.attributes?.country ?? null,
      dateStart: o.attributes?.dateStart ?? null,
      dateEnd: o.attributes?.dateEnd ?? null,
      datePrecisionCode: o.attributes?.datePrecisionCode ?? null,
      geoPrecisionCode: o.attributes?.geoPrecisionCode ?? null,
      fatalitiesBest: o.attributes?.fatalitiesBest ?? null,
      fatalitiesLow: o.attributes?.fatalitiesLow ?? null,
      fatalitiesHigh: o.attributes?.fatalitiesHigh ?? null,
      associationFamily: o.attributes?.associationFamily ?? null,
      sourceDomains: o.attributes?.sourceDomains ?? null,
      sourceCount: o.attributes?.sourceCount ?? null,
      maxSpatialDistanceKm: o.attributes?.maxSpatialDistanceKm ?? null,
      watchRank: o.attributes?.watchRank ?? null,
      corroborationScore: o.attributes?.corroborationScore ?? null,
      timeWindowHours: o.attributes?.timeWindowHours ?? null,
      analysisCellSizeKm: o.attributes?.analysisCellSizeKm ?? null,
      analysisCellBbox: o.attributes?.analysisCellBbox ?? null,
      evidenceDomains: o.attributes?.evidenceDomains ?? null,
      domainCounts: o.attributes?.domainCounts ?? null,
      factorScores: o.attributes?.factorScores ?? null,
      avgCrossDomainDistanceKm: o.attributes?.avgCrossDomainDistanceKm ?? null,
      avgCrossDomainTemporalGapHours: o.attributes?.avgCrossDomainTemporalGapHours ?? null,
      newestEvidenceAt: o.attributes?.newestEvidenceAt ?? null,
    },
    provenance: o.provenance,
    derived: o.derived,
  };
}

function temporalCandidateSet(records) {
  const current = records.filter(o => o?.temporal?.status === 'current');
  if (current.length) return { records: current, scope: 'current' };
  const ageing = records.filter(o => o?.temporal?.status === 'ageing');
  if (ageing.length) return { records: ageing, scope: 'ageing' };
  const stale = records.filter(o => o?.temporal?.status === 'stale');
  if (stale.length) return { records: stale, scope: 'stale-last-known' };
  return { records, scope: 'unclassified' };
}

function summarizeTemporal(records) {
  const out = { total: records.length, current: 0, ageing: 0, stale: 0, unknown: 0 };
  for (const o of records) {
    const st = o?.temporal?.status;
    if (st === 'current' || st === 'ageing' || st === 'stale') out[st]++;
    else out.unknown++;
  }
  return out;
}

function newestRecord(records) {
  return records.slice().sort((a, b) => Date.parse(b?.observedAt || 0) - Date.parse(a?.observedAt || 0))[0] || null;
}

function topNumeric(records, path, direction = 'desc') {
  return records.map(o => ({ o, value: numericPath(o, path) }))
    .filter(x => x.value !== null)
    .sort((a, b) => direction === 'asc' ? a.value - b.value : b.value - a.value);
}

function buildSummaryEvidence(question, observations) {
  const q = question.toLowerCase();
  const wantsSummary = /\b(summarise|summarize|summary|overview|operational picture|current picture|situation|watchlist|analysis areas?|corroboration|corroborating|associations?|fusion|reported events?|evidence chains?)\b/.test(q);
  if (!wantsSummary) return null;

  const byDomain = {};
  for (const o of observations) {
    const d = observationDomainForQuery(o);
    (byDomain[d] ||= []).push(o);
  }
  const domainCounts = {};
  for (const [d, records] of Object.entries(byDomain)) domainCounts[d] = summarizeTemporal(records);

  const thermal = byDomain.thermal || [];
  const eoChanges = byDomain.earthObservationChange || [];
  const reported = byDomain.reportedConflict || [];
  const maritime = byDomain.maritimeActivity || [];
  const associations = byDomain.crossSourceAssociation || [];
  const chains = byDomain.evidenceChain || [];
  const watchAreas = byDomain.corroborationArea || [];
  const watchRank = topNumeric(watchAreas, 'attributes.corroborationScore', 'desc');
  const thermalRank = topNumeric(thermal, 'attributes.totalFrpMw', 'desc');
  const eoRank = topNumeric(eoChanges, 'attributes.regionAreaKm2', 'desc');
  const assocRank = topNumeric(associations, 'attributes.spatialDistanceKm', 'asc');
  const chainRank = topNumeric(chains, 'attributes.maxSpatialDistanceKm', 'asc');
  const reportedFatalityRank = topNumeric(reported, 'attributes.fatalitiesBest', 'desc');
  const totalThermalFrp = thermal.reduce((a, o) => a + (numericPath(o, 'attributes.totalFrpMw') || 0), 0);
  const upperDecile = thermal.filter(o => String(o?.attributes?.relativeFrpTier || '') === 'upper-decile').length;
  const totalEoArea = eoChanges.reduce((a, o) => a + (numericPath(o, 'attributes.regionAreaKm2') || 0), 0);
  const maritimeByType = {};
  for (const o of maritime) { const k=String(o?.attributes?.maritimeActivityType||'UNKNOWN'); maritimeByType[k]=(maritimeByType[k]||0)+1; }

  const familyCounts = {};
  for (const a of associations) {
    const f = String(a?.attributes?.associationFamily || 'unspecified');
    familyCounts[f] = (familyCounts[f] || 0) + 1;
  }

  const summary = {
    totalObservations: observations.length,
    domains: domainCounts,
    reportedConflict: {
      events: reported.length,
      temporal: summarizeTemporal(reported),
      newest: newestRecord(reported) ? queryResultRecord(newestRecord(reported)) : null,
      highestReportedFatalitiesBest: reportedFatalityRank[0] ? { ...queryResultRecord(reportedFatalityRank[0].o), deterministicValue: reportedFatalityRank[0].value } : null,
    },
    maritimeActivity: {
      events: maritime.length,
      temporal: summarizeTemporal(maritime),
      byType: maritimeByType,
      newest: newestRecord(maritime) ? queryResultRecord(newestRecord(maritime)) : null,
    },
    thermal: {
      clusters: thermal.length,
      temporal: summarizeTemporal(thermal),
      totalFrpMw: +totalThermalFrp.toFixed(2),
      upperDecileClusters: upperDecile,
      newest: newestRecord(thermal) ? queryResultRecord(newestRecord(thermal)) : null,
      highestTotalFrp: thermalRank[0] ? { ...queryResultRecord(thermalRank[0].o), deterministicValue: thermalRank[0].value } : null,
    },
    earthObservationChange: {
      regions: eoChanges.length,
      temporal: summarizeTemporal(eoChanges),
      totalRegionAreaKm2: +totalEoArea.toFixed(3),
      largestRegion: eoRank[0] ? { ...queryResultRecord(eoRank[0].o), deterministicValue: eoRank[0].value } : null,
    },
    crossSourceAssociations: {
      associations: associations.length,
      temporal: summarizeTemporal(associations),
      byFamily: familyCounts,
      nearest: assocRank[0] ? { ...queryResultRecord(assocRank[0].o), deterministicValue: assocRank[0].value } : null,
    },
    evidenceChains: {
      chains: chains.length,
      temporal: summarizeTemporal(chains),
      tightest: chainRank[0] ? { ...queryResultRecord(chainRank[0].o), deterministicValue: chainRank[0].value } : null,
    },
    corroborationWatchlist: {
      areas: watchAreas.length,
      selectedWindowHours: watchAreas[0]?.attributes?.timeWindowHours ?? null,
      highestScoring: watchRank[0] ? { ...queryResultRecord(watchRank[0].o), deterministicValue: watchRank[0].value } : null,
      topAreas: watchRank.slice(0, 5).map(x => ({ ...queryResultRecord(x.o), deterministicValue: x.value })),
    },
  };

  const records = [];
  const pushUnique = (o) => {
    if (!o) return;
    const r = queryResultRecord(o);
    if (!records.some(x => x.id === r.id && x.entityId === r.entityId)) records.push(r);
  };
  watchRank.slice(0, 5).forEach(x => pushUnique(x.o));
  chainRank.slice(0, 5).forEach(x => pushUnique(x.o));
  reportedFatalityRank.slice(0, 3).forEach(x => pushUnique(x.o));
  pushUnique(newestRecord(reported));
  maritime.slice().sort((a,b)=>Date.parse(b?.observedAt||0)-Date.parse(a?.observedAt||0)).slice(0,5).forEach(pushUnique);
  thermalRank.slice(0, 4).forEach(x => pushUnique(x.o));
  pushUnique(newestRecord(thermal));
  eoRank.slice(0, 3).forEach(x => pushUnique(x.o));
  assocRank.slice(0, 4).forEach(x => pushUnique(x.o));

  if (/operational picture|current picture|situation|overview/.test(q)) {
    for (const d of ['weather', 'earthquakes', 'satellites', 'earthObservation', 'aircraft', 'vessels', 'maritimeActivity']) {
      const rec = (byDomain[d] || []).find(o => o?.temporal?.status === 'current') || newestRecord(byDomain[d] || []);
      pushUnique(rec);
    }
  }

  return {
    applied: true,
    intent: 'summary',
    domain: /watchlist|corrobor|ucdp|reported|evidence chain/.test(q) ? 'multi-source-reported-sensor' : (/firms|thermal/.test(q) ? 'multi-source-thermal-eo' : 'multi-source'),
    metric: 'deterministicSummary',
    direction: null,
    temporalScope: 'all-retained',
    candidateCount: observations.length,
    summary,
    records: records.slice(0, 20),
  };
}

function deterministicFallbackAnswer(evidence) {
  if (!evidence?.applied || evidence.intent !== 'summary') return null;
  const s = evidence.summary || {};
  const r = s.reportedConflict || {};
  const m = s.maritimeActivity || {};
  const t = s.thermal || {};
  const e = s.earthObservationChange || {};
  const a = s.crossSourceAssociations || {};
  const c = s.evidenceChains || {};
  const w = s.corroborationWatchlist || {};
  const lines = ['Deterministic Twinstone summary'];
  lines.push('', `Reported conflict events: ${r.events || 0} retained UCDP Candidate event${r.events === 1 ? '' : 's'}. These are coded reports, not physical sensor observations.`);
  if (r.newest) lines.push(`Newest retained UCDP source date: ${r.newest.attributes?.dateEnd || r.newest.observedAt || '--'}; type ${r.newest.attributes?.typeOfViolence || 'unknown'}; source date precision code ${r.newest.attributes?.datePrecisionCode ?? 'unknown'}.`);
  lines.push('', `Maritime activity: ${m.events || 0} retained Global Fishing Watch AIS-derived event${m.events === 1 ? '' : 's'}${m.byType ? ` (${Object.entries(m.byType).map(([k,v])=>`${k}: ${v}`).join(', ')})` : ''}. These are algorithmic activity records, not live vessel positions.`);
  if (m.newest) lines.push(`Newest retained maritime activity: ${m.newest.attributes?.maritimeActivityType || 'unknown'} for ${m.newest.attributes?.vesselName || m.newest.label || 'vessel'} at ${m.newest.observedAt || '--'}.`);
  if (t.clusters !== undefined) {
    lines.push('', `Thermal anomalies: ${t.clusters} retained FIRMS cluster${t.clusters === 1 ? '' : 's'}; ${t.temporal?.current || 0} current, ${t.temporal?.ageing || 0} ageing and ${t.temporal?.stale || 0} stale. Combined cluster FRP is ${Number(t.totalFrpMw || 0).toFixed(2)} MW; ${t.upperDecileClusters || 0} cluster${t.upperDecileClusters === 1 ? '' : 's'} ${t.upperDecileClusters === 1 ? 'is' : 'are'} in Twinstone's upper-decile FRP tier.`);
    if (t.highestTotalFrp) lines.push(`Highest total-FRP cluster: ${t.highestTotalFrp.attributes?.totalFrpMw ?? t.highestTotalFrp.deterministicValue} MW at ${t.highestTotalFrp.location?.lat ?? '--'}, ${t.highestTotalFrp.location?.lon ?? '--'}, observed ${t.highestTotalFrp.observedAt || '--'}.`);
  }
  lines.push('', `EO change screening: ${e.regions || 0} derived change region${e.regions === 1 ? '' : 's'} covering approximately ${Number(e.totalRegionAreaKm2 || 0).toFixed(3)} km² in total.`);
  if (e.largestRegion) lines.push(`Largest EO change region: ${e.largestRegion.attributes?.regionAreaKm2 ?? e.largestRegion.deterministicValue} km²; comparison quality ${e.largestRegion.attributes?.comparisonQuality || 'unknown'}.`);
  lines.push('', `Cross-source associations: ${a.associations || 0} deterministic pairwise proximity relationship${a.associations === 1 ? '' : 's'}${a.byFamily ? ` (${Object.entries(a.byFamily).map(([k,v])=>`${k}: ${v}`).join(', ')})` : ''}.`);
  lines.push(`Three-source evidence chains: ${c.chains || 0}. A chain requires a UCDP reported event, FIRMS cluster and EO-change region to form a closed set of qualifying pairwise associations.`);
  if (c.tightest) lines.push(`Tightest chain maximum pairwise distance: ${c.tightest.attributes?.maxSpatialDistanceKm ?? c.tightest.deterministicValue} km.`);
  lines.push('', `Corroboration watchlist: ${w.areas || 0} coarse analysis area${w.areas === 1 ? '' : 's'} ranked within the selected ${w.selectedWindowHours || 'configured'} h window.`);
  if (w.highestScoring) { const a=w.highestScoring.attributes||{}; lines.push(`Highest-scoring area: ${w.highestScoring.label || 'area'} at ${w.highestScoring.deterministicValue}/100 using ${a.sourceCount || 0} independent evidence classes. Score factors: sources ${a.factorScores?.independentSources ?? '--'}/30, recency ${a.factorScores?.recency ?? '--'}/25, spatial ${a.factorScores?.spatialCoherence ?? '--'}/20, temporal ${a.factorScores?.temporalCoherence ?? '--'}/15, quality ${a.factorScores?.evidenceQuality ?? '--'}/10.`); }
  lines.push('', 'Assessment boundary: UCDP is reported/coded event evidence, FIRMS is thermal-anomaly evidence, EO comparison is derived sensor-change evidence, Global Fishing Watch maritime events are AIS-derived algorithmic activity records, and Twinstone associations/chains are deterministic proximity relationships. GFW events do not establish confirmed fishing, transshipment, deliberate AIS disabling, intent or wrongdoing. Even a three-source chain does not prove common cause, strike, damage, actor or attribution.');
  return lines.join('\n');
}

function usefulAgentAnswer(answer, evidence) {
  const text = String(answer || '').trim();
  if (!text) return false;
  if (/^[\s+\-0-9:.,|TZ]+$/i.test(text)) return false;
  if (evidence?.intent === 'summary') {
    const words = text.match(/[A-Za-z]{3,}/g) || [];
    if (text.length < 120 || words.length < 12) return false;
  }
  return true;
}

function buildDeterministicEvidence(question, observations) {
  const q = question.toLowerCase().replace(/[^a-z0-9. ]+/g, ' ');
  const summaryEvidence = buildSummaryEvidence(question, observations);
  if (summaryEvidence) return summaryEvidence;
  let domain = null;
  if (/\b(aircraft|plane|planes|flight|flights)\b/.test(q)) domain = 'aircraft';
  else if (/\b(global fishing watch|gfw|maritime activity|fishing event|fishing events|encounter|encounters|loitering|port visit|port visits|ais gap|ais gaps)\b/.test(q)) domain = 'maritimeActivity';
  else if (/\b(vessel|vessels|ship|ships)\b/.test(q)) domain = 'vessels';
  else if (/\b(satellite|satellites|spacecraft)\b/.test(q)) domain = 'satellites';
  else if (/\b(firms|thermal|hotspot|hotspots|fire anomaly|fire anomalies|thermal anomaly|thermal anomalies)\b/.test(q)) domain = 'thermal';
  else if (/\b(ucdp|reported conflict|reported event|reported events|conflict event|conflict events)\b/.test(q)) domain = 'reportedConflict';
  else if (/\b(evidence chain|evidence chains|three source|three-source)\b/.test(q)) domain = 'evidenceChain';
  else if (/\b(sentinel|sentinel 1|sentinel 2|earth observation|imagery|sar|optical|acquisition|acquisitions)\b/.test(q)) domain = 'earthObservation';

  const domainRecords = domain ? observations.filter(o => observationDomainForQuery(o) === domain) : observations;

  // Deterministic counts.
  if (/\b(how many|count|number of)\b/.test(q) && domain) {
    const counts = { current: 0, ageing: 0, stale: 0, unknown: 0 };
    for (const o of domainRecords) {
      const s = o?.temporal?.status;
      if (s === 'current' || s === 'ageing' || s === 'stale') counts[s]++;
      else counts.unknown++;
    }
    return {
      applied: true,
      intent: 'count',
      domain,
      metric: 'entityCount',
      direction: null,
      temporalScope: 'all',
      candidateCount: domainRecords.length,
      counts,
      records: [],
    };
  }

  let metric = null, direction = 'desc', intent = 'rank';
  if (/\b(fastest|quickest|highest speed|greatest speed|top speed)\b/.test(q)) {
    metric = domain === 'satellites' ? 'kinematics.speedKmS' : 'kinematics.speedKts'; direction = 'desc';
  } else if (/\b(slowest|lowest speed)\b/.test(q)) {
    metric = domain === 'satellites' ? 'kinematics.speedKmS' : 'kinematics.speedKts'; direction = 'asc';
  } else if (/\b(nearest|closest)\b/.test(q) && /\b(dover|distance)\b/.test(q)) {
    metric = 'derived.distanceToDoverKm'; direction = 'asc';
  } else if (/\b(farthest|furthest)\b/.test(q) && /\b(dover|distance)\b/.test(q)) {
    metric = 'derived.distanceToDoverKm'; direction = 'desc';
  } else if (domain === 'thermal' && /\b(highest frp|largest frp|most energetic|greatest frp|strongest thermal)\b/.test(q)) {
    metric = 'attributes.totalFrpMw'; direction = 'desc';
  } else if (/\b(highest|greatest)\b/.test(q) && /\b(altitude|flying|aircraft|plane|satellite|spacecraft)\b/.test(q)) {
    metric = domain === 'satellites' ? 'kinematics.altitudeKm' : 'kinematics.altitudeFt'; direction = 'desc';
  } else if (/\b(lowest)\b/.test(q) && /\b(altitude|flying|aircraft|plane|satellite|spacecraft)\b/.test(q)) {
    metric = domain === 'satellites' ? 'kinematics.altitudeKm' : 'kinematics.altitudeFt'; direction = 'asc';
  }

  if (!metric || !domain) return { applied: false, records: observations };

  const temporal = temporalCandidateSet(domainRecords);
  const candidates = temporal.records
    .map(o => ({ o, value: numericPath(o, metric) }))
    .filter(x => x.value !== null)
    .sort((a, b) => direction === 'asc' ? a.value - b.value : b.value - a.value);

  const top = candidates.slice(0, 5).map(x => ({ ...queryResultRecord(x.o), deterministicValue: x.value }));

  return {
    applied: true,
    intent,
    domain,
    metric,
    direction,
    temporalScope: temporal.scope,
    candidateCount: candidates.length,
    records: top,
  };
}

function summarizeForModel(observations) {
  const summary = {};
  for (const o of observations) {
    const source = o.source || 'unknown';
    if (!summary[source]) summary[source] = { total: 0, current: 0, ageing: 0, stale: 0 };
    summary[source].total++;
    const status = o.temporal?.status;
    if (status === 'current' || status === 'ageing' || status === 'stale') summary[source][status]++;
  }
  return summary;
}


async function workerConnectivityDiagnostics(env, bbox) {
  const startedAt = new Date().toISOString();
  const ukraine = { west: 22, south: 44, east: 41, north: 53 };
  const centre = bboxCenter(bbox);
  const firmsKey = secret(env, 'FIRMS_MAP_KEY');
  const aishubUser = secret(env, 'AISHUB_USERNAME');
  const gfwToken = secret(env, 'GFW_API_TOKEN');
  const adsbxKey = secret(env, 'ADSBEXCHANGE_API_KEY');
  const acledToken = secret(env, 'ACLED_ACCESS_TOKEN');
  const ucdpToken = secret(env, 'UCDP_ACCESS_TOKEN');
  const reliefWebAppname = secret(env, 'RELIEFWEB_APPNAME');

  const firmsUrl = firmsKey
    ? `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(firmsKey)}/VIIRS_NOAA20_NRT/${ukraine.west},${ukraine.south},${ukraine.east},${ukraine.north}/1`
    : 'https://firms.modaps.eosdis.nasa.gov/api/';

  const aishubUrl = aishubUser
    ? `https://data.aishub.net/ws.php?username=${encodeURIComponent(aishubUser)}&format=1&output=json&compress=0&latmin=${bbox.south}&latmax=${bbox.north}&lonmin=${bbox.west}&lonmax=${bbox.east}&interval=5`
    : 'https://data.aishub.net/ws.php?username=TWINSTONE_CONNECTIVITY_TEST&format=1&output=json&compress=0&latmin=49.4&latmax=52.2&lonmin=-5.8&lonmax=3.0&interval=5';

  const tests = [
    () => diagnosticHttpProbe({
      id: 'openmeteo', name: 'Open-Meteo', domain: 'Weather',
      url: `https://api.open-meteo.com/v1/forecast?latitude=${centre.lat.toFixed(4)}&longitude=${centre.lon.toFixed(4)}&current=temperature_2m`,
      timeoutMs: 8000,
      parse: async r => { const d = await r.json(); return { detail: `temperature field ${d?.current?.temperature_2m != null ? 'present' : 'missing'}` }; },
    }),
    () => diagnosticHttpProbe({
      id: 'noaa-nws', name: 'NOAA / NWS API', domain: 'Weather',
      url: 'https://api.weather.gov/points/38.8894,-77.0352', timeoutMs: 10000,
      options: { headers: { 'User-Agent': `Twinstone-source-qualification/${VERSION} contact=diagnostic` } },
      parse: async r => { const d = await r.json(); return { detail: d?.properties?.forecast ? 'JSON-LD point metadata present' : 'API reachable' }; },
    }),
    () => diagnosticHttpProbe({
      id: 'usgs', name: 'USGS GeoJSON', domain: 'Geophysical',
      url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson', timeoutMs: 8000,
      parse: async r => { const d = await r.json(); return { count: Array.isArray(d?.features) ? d.features.length : null, detail: 'M2.5+ day feed' }; },
    }),
    () => diagnosticHttpProbe({
      id: 'firms', name: 'NASA FIRMS', domain: 'Thermal / fire', url: firmsUrl, timeoutMs: 12000,
      authRequired: true, credentialConfigured: Boolean(firmsKey), credentialName: 'FIRMS_MAP_KEY',
      successWithoutCredentialIsReachabilityOnly: true,
      parse: async r => {
        const text = await r.text();
        if (!firmsKey) return { detail: 'API host reachable; operational Ukraine area data needs FIRMS_MAP_KEY' };
        const lines = text.trim() ? text.trim().split(/\r?\n/) : [];
        return { count: Math.max(0, lines.length - 1), detail: 'VIIRS NOAA-20 NRT Ukraine-area CSV probe' };
      },
    }),
    () => diagnosticOpenSkyProbe(env, bbox),
    () => diagnosticHttpProbe({
      id: 'adsblol', name: 'ADSB.lol', domain: 'Aircraft',
      url: `https://api.adsb.lol/v2/point/${centre.lat.toFixed(4)}/${centre.lon.toFixed(4)}/50`, timeoutMs: 10000,
      parse: async r => { const d = await r.json(); return { count: Array.isArray(d?.ac) ? d.ac.length : null, detail: '50 NM point query' }; },
    }),
    () => diagnosticHttpProbe({
      id: 'adsbx', name: 'ADS-B Exchange API', domain: 'Aircraft',
      url: 'https://gateway.adsbexchange.com/api/aircraft/v2/icao/A465DF', timeoutMs: 12000,
      options: { headers: { ...(adsbxKey ? { 'X-Api-Key': adsbxKey, 'Accept-Encoding': 'gzip' } : {}) } },
      authRequired: true, credentialConfigured: Boolean(adsbxKey), credentialName: 'ADSBEXCHANGE_API_KEY', expectedAuthStatuses: [401,402,403],
      parse: async r => { const d = await r.json(); return { count: Array.isArray(d?.ac) ? d.ac.length : null, detail: adsbxKey ? 'Authenticated Europe query' : 'Gateway reachable; API key/licence required' }; },
    }),
    () => diagnosticHttpProbe({
      id: 'aishub', name: 'AISHub REST', domain: 'Maritime', url: aishubUrl, timeoutMs: 12000,
      authRequired: true, credentialConfigured: Boolean(aishubUser), credentialName: 'AISHUB_USERNAME', successWithoutCredentialIsReachabilityOnly: true,
      parse: async r => {
        const text = await r.text();
        if (!aishubUser) return { detail: 'REST webservice reachable; member/contributor username required for data' };
        let count = null; try { const d = JSON.parse(text); if (Array.isArray(d)) count = d.length; } catch (_) {}
        return { count, detail: 'AISHub English Channel JSON probe; do not poll more than once/minute' };
      },
    }),
    () => diagnosticHttpProbe({
      id: 'gfw', name: 'Global Fishing Watch v3', domain: 'Maritime intelligence',
      url: 'https://gateway.api.globalfishingwatch.org/v3/vessels/search?query=7831410&datasets[0]=public-global-vessel-identity:latest', timeoutMs: 12000,
      options: { headers: { ...(gfwToken ? { Authorization: `Bearer ${gfwToken}` } : {}) } },
      authRequired: true, credentialConfigured: Boolean(gfwToken), credentialName: 'GFW_API_TOKEN', expectedAuthStatuses: [401,403],
      parse: async r => { const d = await r.json(); return { count: Array.isArray(d?.entries) ? d.entries.length : (Array.isArray(d?.data) ? d.data.length : null), detail: gfwToken ? `Authenticated GFW v3 bearer-token probe; Twinstone v${VERSION} /maritime uses the Events API with bounded geometry` : `REST gateway reachable; bearer token required for Twinstone v${VERSION} maritime activity` }; },
    }),
    () => diagnosticHttpProbe({
      id: 'celestrak', name: 'CelesTrak', domain: 'Space',
      url: 'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=JSON', timeoutMs: 12000,
      parse: async r => { const d = await r.json(); return { count: Array.isArray(d) ? d.length : null, detail: 'ISS GP/OMM JSON probe' }; },
    }),
    () => diagnosticHttpProbe({
      id: 'copernicus-s1', name: 'Copernicus Sentinel-1 STAC', domain: 'Earth observation / SAR',
      url: `https://stac.dataspace.copernicus.eu/v1/search?collections=sentinel-1-grd&bbox=${ukraine.west},${ukraine.south},${ukraine.east},${ukraine.north}&limit=1`, timeoutMs: 15000,
      parse: async r => { const d = await r.json(); return { count: Array.isArray(d?.features) ? d.features.length : null, detail: 'Sentinel-1 GRD catalogue search over Ukraine' }; },
    }),
    () => diagnosticHttpProbe({
      id: 'copernicus-s2', name: 'Copernicus Sentinel-2 STAC', domain: 'Earth observation / optical',
      url: `https://stac.dataspace.copernicus.eu/v1/search?collections=sentinel-2-l2a&bbox=${ukraine.west},${ukraine.south},${ukraine.east},${ukraine.north}&limit=1`, timeoutMs: 15000,
      parse: async r => { const d = await r.json(); return { count: Array.isArray(d?.features) ? d.features.length : null, detail: 'Sentinel-2 L2A catalogue search over Ukraine' }; },
    }),
    () => diagnosticHttpProbe({
      id: 'gdelt-geo', name: 'GDELT GEO 2.0', domain: 'News / geospatial events',
      url: 'https://api.gdeltproject.org/api/v2/geo/geo?query=Ukraine&mode=pointdata&maxpoints=1&format=geojson&timespan=60', timeoutMs: 15000,
      parse: async r => { const d = await r.json(); return { count: Array.isArray(d?.features) ? d.features.length : null, detail: 'Ukraine point-data GeoJSON probe' }; },
    }),
    () => diagnosticHttpProbe({
      id: 'gdelt-doc', name: 'GDELT DOC 2.0', domain: 'News / narrative context',
      url: 'https://api.gdeltproject.org/api/v2/doc/doc?query=Ukraine&mode=artlist&maxrecords=1&format=json&timespan=1h', timeoutMs: 15000,
      parse: async r => { const d = await r.json(); return { count: Array.isArray(d?.articles) ? d.articles.length : null, detail: 'Ukraine article-list JSON probe' }; },
    }),
    () => diagnosticHttpProbe({
      id: 'acled', name: 'ACLED API', domain: 'Conflict events',
      url: 'https://acleddata.com/api/acled/read?_format=json&country=Ukraine&limit=1', timeoutMs: 15000,
      options: { headers: { ...(acledToken ? { Authorization: `Bearer ${acledToken}` } : {}) } },
      authRequired: true, credentialConfigured: Boolean(acledToken), credentialName: 'ACLED_ACCESS_TOKEN', expectedAuthStatuses: [401,403],
      parse: async r => { const d = await r.json(); return { count: Array.isArray(d?.data) ? d.data.length : null, detail: acledToken ? 'Authenticated Ukraine event probe' : 'API reachable; ACLED OAuth access token required' }; },
    }),
    () => diagnosticHttpProbe({
      id: 'ucdp', name: 'UCDP GED API', domain: 'Conflict events',
      url: `https://ucdpapi.pcr.uu.se/api/gedevents/${encodeURIComponent(secret(env, 'UCDP_API_VERSION') || UCDP_API_VERSION)}?pagesize=1&Country=369`, timeoutMs: 15000,
      options: { headers: { ...(ucdpToken ? { 'x-ucdp-access-token': ucdpToken } : {}) } },
      authRequired: true, credentialConfigured: Boolean(ucdpToken), credentialName: 'UCDP_ACCESS_TOKEN', expectedAuthStatuses: [401,403],
      parse: async r => { const d = await r.json(); return { count: Array.isArray(d?.Result) ? d.Result.length : null, totalCount: d?.TotalCount ?? null, detail: ucdpToken ? `Authenticated UCDP Candidate Ukraine probe (${secret(env, 'UCDP_API_VERSION') || UCDP_API_VERSION})` : 'API reachable; x-ucdp-access-token required' }; },
    }),
    () => diagnosticHttpProbe({
      id: 'ioda', name: 'IODA v2 outage events', domain: 'Connectivity context',
      url: `https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events?from=${Math.floor(Date.now()/1000)-86400}&until=${Math.floor(Date.now()/1000)}&entityType=country&limit=1&format=ioda`, timeoutMs: 12000,
      parse: async r => { const d = await r.json(); const a=Array.isArray(d)?d:(Array.isArray(d?.data)?d.data:[]); return { count:a.length, detail:'IODA v2 recent country outage-event probe' }; },
    }),
    () => diagnosticHttpProbe({
      id: 'swpc', name: 'NOAA SWPC planetary K index', domain: 'Space-weather context',
      url: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', timeoutMs: 12000,
      parse: async r => { const d=await r.json(); return { count:Array.isArray(d)?Math.max(0,d.length-1):null, detail:'Official SWPC planetary K-index JSON product' }; },
    }),
    () => diagnosticHttpProbe({
      id: 'reliefweb', name: 'ReliefWeb API v2', domain: 'Humanitarian context',
      url: reliefWebAppname ? `https://api.reliefweb.int/v2/reports?appname=${encodeURIComponent(reliefWebAppname)}&limit=1&preset=latest` : 'https://api.reliefweb.int/v2/reports?appname=TWINSTONE-REGISTRATION-REQUIRED&limit=1', timeoutMs: 12000,
      authRequired: true, credentialConfigured: Boolean(reliefWebAppname), credentialName: 'RELIEFWEB_APPNAME', successWithoutCredentialIsReachabilityOnly: true,
      parse: async r => { const d=await r.json(); return { count:Array.isArray(d?.data)?d.data.length:null, detail: reliefWebAppname?'Pre-approved ReliefWeb appname probe':'API host reachable; pre-approved appname required' }; },
    }),
    () => diagnosticHttpProbe({
      id: 'who-don', name: 'WHO Disease Outbreak News', domain: 'Public-health context',
      url: 'https://www.who.int/api/news/diseaseoutbreaknews?$select=Id,PublicationDateAndTime,Title,DonId&$top=1&$orderby=PublicationDateAndTime%20desc', timeoutMs: 12000,
      parse: async r => { const d=await r.json(); return { count:Array.isArray(d?.value)?d.value.length:null, detail:'WHO Disease Outbreak News REST/OData probe' }; },
    }),
    () => diagnosticHttpProbe({
      id: 'isw', name: 'Institute for the Study of War', domain: 'Military assessment / context',
      url: 'https://www.understandingwar.org/project/ukraine-project', timeoutMs: 15000,
      parse: async r => { const text = await r.text(); return { detail: `Ukraine Project HTML reachable (${Math.round(text.length/1024)} KB)` }; },
    }),
    () => diagnosticHttpProbe({
      id: 'uk-sanctions', name: 'UK Sanctions List CSV', domain: 'Sanctions / identity',
      url: 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv', timeoutMs: 15000,
      parse: async r => { const text = await r.text(); const lines = text.trim() ? text.split(/\r?\n/) : []; return { count: Math.max(0, lines.length-1), detail: 'Official FCDO UK Sanctions List CSV' }; },
    }),
  ];

  const ids = ['openmeteo','noaa-nws','usgs','firms','opensky','adsblol','adsbx','aishub','gfw','celestrak','copernicus-s1','copernicus-s2','gdelt-geo','gdelt-doc','acled','ucdp','ioda','swpc','reliefweb','who-don','isw','uk-sanctions'];
  const names = ['Open-Meteo','NOAA / NWS API','USGS GeoJSON','NASA FIRMS','OpenSky','ADSB.lol','ADS-B Exchange API','AISHub REST','Global Fishing Watch v3','CelesTrak','Copernicus Sentinel-1 STAC','Copernicus Sentinel-2 STAC','GDELT GEO 2.0','GDELT DOC 2.0','ACLED API','UCDP GED API','IODA v2 outage events','NOAA SWPC planetary K index','ReliefWeb API v2','WHO Disease Outbreak News','Institute for the Study of War','UK Sanctions List CSV'];
  const settled = await Promise.allSettled(tests.map(fn => fn()));
  const results = settled.map((r, i) => r.status === 'fulfilled' ? r.value : {
    id: ids[i], name: names[i], status: 'error', usable: false, reachable: false, latencyMs: null, httpStatus: null, detail: safeError(r.reason),
  });

  return {
    status: 'ok', service: 'Twinstone', version: VERSION,
    diagnosticProfile: 'Source Qualification v2 — UK/English Channel + Ukraine',
    generatedAt: new Date().toISOString(), startedAt,
    path: 'Cloudflare Worker -> source over HTTPS', bbox, ukraineBbox: ukraine,
    tests: results,
    credentialPresence: {
      firms: Boolean(firmsKey), aishub: Boolean(aishubUser), globalFishingWatch: Boolean(gfwToken), adsbExchange: Boolean(adsbxKey),
      acled: Boolean(acledToken), ucdp: Boolean(ucdpToken), openskyOAuth: Boolean(secret(env,'OPENSKY_CLIENT_ID') && secret(env,'OPENSKY_CLIENT_SECRET')),
    },
    knownConstraints: {
      aisstream: 'WebSocket transport intentionally not tested because socket-style access is already known to fail in the intended environment.',
      protectedApis: 'A protected API can be transport-reachable even when the diagnostic reports credentials required. Secret values are never returned.',
      firms: 'When FIRMS_MAP_KEY is absent, the probe qualifies the API host only. With the secret configured it queries VIIRS NOAA-20 NRT over Ukraine.',
      aishub: 'AISHub webservice should not be accessed more frequently than once per minute.',
    },
  };
}

async function diagnosticHttpProbe({ id, name, domain = '', url, timeoutMs = 10000, options = {}, parse = null, authRequired = false, credentialConfigured = false, credentialName = null, expectedAuthStatuses = [401,403], successWithoutCredentialIsReachabilityOnly = false }) {
  const started = Date.now();
  try {
    const response = await safeFetch(url, { headers: { 'Accept': '*/*', ...(options.headers || {}) }, ...options }, timeoutMs);
    const latencyMs = Date.now() - started;
    let extra = {};
    if (parse) {
      try { extra = await parse(response.clone()) || {}; }
      catch (error) { extra = { detail: `HTTP reachable, response parse failed: ${safeError(error)}` }; }
    }

    let status = response.ok ? 'pass' : 'http-error';
    let usable = response.ok;
    if (!response.ok && authRequired && expectedAuthStatuses.includes(response.status)) {
      status = credentialConfigured ? 'auth-error' : 'credential-required';
      usable = false;
    } else if (response.ok && authRequired && !credentialConfigured) {
      status = 'credential-required';
      usable = false;
    }

    return {
      id, name, domain, status, usable, reachable: true,
      httpStatus: response.status, latencyMs, urlHost: new URL(url).hostname,
      authRequired, credentialConfigured, credentialName,
      ...extra,
    };
  } catch (error) {
    const message = safeError(error);
    return {
      id, name, domain,
      status: /Timeout/i.test(message) ? 'timeout' : 'network-error',
      usable: false, reachable: false, httpStatus: null,
      latencyMs: Date.now() - started, urlHost: new URL(url).hostname,
      authRequired, credentialConfigured, credentialName, detail: message,
    };
  }
}

async function diagnosticOpenSkyProbe(env, bbox) {
  const started = Date.now();
  const clientId = secret(env, 'OPENSKY_CLIENT_ID');
  const clientSecret = secret(env, 'OPENSKY_CLIENT_SECRET');
  const hasOAuth = Boolean(clientId && clientSecret);
  const authUrl = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
  let token = null;
  let authLatencyMs = null;

  try {
    if (hasOAuth) {
      const authStart = Date.now();
      const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString();
      const auth = await safeFetch(authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body,
      }, 12000);
      authLatencyMs = Date.now() - authStart;
      if (!auth.ok) {
        const text = (await auth.text()).slice(0, 180);
        return { id:'opensky', name:'OpenSky', status:'http-error', usable:false, stage:'oauth', httpStatus:auth.status, latencyMs:Date.now()-started, authLatencyMs, mode:'oauth', detail:`OAuth HTTP ${auth.status}: ${text}` };
      }
      const data = await auth.json();
      token = data?.access_token || null;
      if (!token) return { id:'opensky', name:'OpenSky', status:'error', usable:false, stage:'oauth', httpStatus:auth.status, latencyMs:Date.now()-started, authLatencyMs, mode:'oauth', detail:'OAuth response contained no access_token.' };
    }

    const u = new URL('https://opensky-network.org/api/states/all');
    u.searchParams.set('lamin', bbox.south); u.searchParams.set('lomin', bbox.west); u.searchParams.set('lamax', bbox.north); u.searchParams.set('lomax', bbox.east);
    const stateStart = Date.now();
    const response = await safeFetch(u.toString(), { headers: { 'Accept':'application/json', ...(token ? { Authorization:`Bearer ${token}` } : {}) } }, 12000);
    const statesLatencyMs = Date.now() - stateStart;
    if (!response.ok) {
      return { id:'opensky', name:'OpenSky', status:'http-error', usable:false, stage:'states', httpStatus:response.status, latencyMs:Date.now()-started, authLatencyMs, statesLatencyMs, mode:hasOAuth?'oauth':'anonymous', detail:`States HTTP ${response.status}` };
    }
    const data = await response.json();
    return { id:'opensky', name:'OpenSky', status:'pass', usable:true, stage:'complete', httpStatus:response.status, latencyMs:Date.now()-started, authLatencyMs, statesLatencyMs, mode:hasOAuth?'oauth':'anonymous', count:Array.isArray(data?.states)?data.states.length:null, detail:`${hasOAuth?'OAuth':'anonymous'} states query succeeded` };
  } catch (error) {
    const message = safeError(error);
    const stage = token || !hasOAuth ? 'states' : 'oauth';
    return { id:'opensky', name:'OpenSky', status:/Timeout/i.test(message)?'timeout':'network-error', usable:false, stage, httpStatus:null, latencyMs:Date.now()-started, authLatencyMs, mode:hasOAuth?'oauth':'anonymous', detail:message };
  }
}

async function safeFetch(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Timeout after ${timeoutMs} ms fetching ${new URL(url).hostname}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function safeError(error) {
  return String(error?.message || error || 'Unknown error').slice(0, 500);
}
