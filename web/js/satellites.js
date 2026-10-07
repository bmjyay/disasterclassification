/*
 * Satellite catalogue + simple orbit propagation.
 *
 * Orbits are modelled as circular Keplerian orbits using each spacecraft's real
 * altitude and inclination. Plane orientation (RAAN) and phase are illustrative,
 * so positions are representative rather than live tracking.
 */

const EARTH_RADIUS_KM = 6371;
const MU = 398600.4418;            // km^3 / s^2
const EARTH_ROT = 7.2921159e-5;    // rad / s
const DEG = Math.PI / 180;

const CATEGORIES = {
  optical: {
    short: "Sunlight & heat cameras: burn scars, flood extents, damage.",
    label: "Optical & thermal imaging",
    color: "#8fae7f",
    blurb: "Cameras that see reflected sunlight and emitted heat. They map burn scars, " +
           "flood extents and damaged buildings in daylight, and thermal bands spot " +
           "active fires day or night. Clouds and smoke block the view.",
  },
  radar: {
    short: "Sees through cloud and darkness: floods, ground motion.",
    label: "Radar (SAR) & altimetry",
    color: "#c4935f",
    blurb: "Synthetic-aperture radar sends its own microwave pulses, so it sees through " +
           "clouds, smoke and darkness. Ideal for flood mapping during storms and, via " +
           "interferometry (InSAR), measuring ground that moved in an earthquake.",
  },
  weather: {
    short: "Watches storms form, every few minutes.",
    label: "Weather",
    color: "#7b9cb3",
    blurb: "Geostationary imagers stare at one hemisphere and refresh every few minutes, " +
           "tracking cyclones as they form. Polar weather satellites add sounders, " +
           "scatterometers and precipitation radar.",
  },
  comms: {
    short: "Keeps responders connected when networks fail.",
    label: "Communications",
    color: "#9d8bb0",
    blurb: "Relay voice and data. After a disaster knocks out ground networks, satellite " +
           "links keep responders, hospitals and families connected.",
  },
  nav: {
    short: "Positioning, timing and crustal-motion measurement.",
    label: "Navigation (GNSS)",
    color: "#c9b46f",
    blurb: "GPS, Galileo and GLONASS broadcast precise timing signals. Besides positioning, " +
           "networks of ground receivers measure millimetre-scale crustal motion before " +
           "and after earthquakes.",
  },
  crewed: {
    short: "Astronaut photography and station instruments.",
    label: "Crewed stations",
    color: "#b97a7a",
    blurb: "Astronauts photograph disasters by hand, and station-mounted instruments " +
           "measure lightning, vegetation and ocean winds.",
  },
};

// alt: km, inc: degrees, raan/phase: degrees (illustrative). GEO: lng instead.
const SATELLITES = [
  // ── Optical & thermal ──────────────────────────────────────────────────────
  { id: "landsat8", name: "Landsat 8", cat: "optical", alt: 705, inc: 98.2, raan: 20, phase: 0,
    operator: "NASA / USGS", launched: 2013,
    instruments: "OLI (30 m multispectral), TIRS (100 m thermal)",
    purpose: "Long-running land record at 30 m. Used to map burn severity, flood extents and land-cover change.",
    disaster: "Before/after comparison of wildfire burn scars and flooded farmland." },
  { id: "landsat9", name: "Landsat 9", cat: "optical", alt: 705, inc: 98.2, raan: 20, phase: 180,
    operator: "NASA / USGS", launched: 2021,
    instruments: "OLI-2, TIRS-2",
    purpose: "Flies 8 days out of phase with Landsat 8, so together they image every spot every 8 days.",
    disaster: "Burn-scar and flood mapping, paired with Landsat 8." },
  { id: "s2a", name: "Sentinel-2A", cat: "optical", alt: 786, inc: 98.6, raan: 110, phase: 40,
    operator: "ESA / Copernicus", launched: 2015,
    instruments: "MSI: 13 spectral bands at 10–60 m",
    purpose: "High-revisit multispectral imaging of land and coasts for the EU Copernicus programme.",
    disaster: "Core data source for Copernicus Emergency rapid mapping: floods, fires, landslides." },
  { id: "s2b", name: "Sentinel-2B", cat: "optical", alt: 786, inc: 98.6, raan: 110, phase: 220,
    operator: "ESA / Copernicus", launched: 2017,
    instruments: "MSI: 13 spectral bands at 10–60 m",
    purpose: "Twin of Sentinel-2A, 180° apart in the same orbit for a 5-day global revisit.",
    disaster: "Short-wave infrared bands see through smoke to active fire fronts." },
  { id: "s2c", name: "Sentinel-2C", cat: "optical", alt: 786, inc: 98.6, raan: 110, phase: 130,
    operator: "ESA / Copernicus", launched: 2024,
    instruments: "MSI: 13 spectral bands at 10–60 m",
    purpose: "Next unit of the Sentinel-2 series, keeping the constellation running.",
    disaster: "Same rapid-mapping role as its siblings." },
  { id: "terra", name: "Terra", cat: "optical", alt: 705, inc: 98.2, raan: 60, phase: 90,
    operator: "NASA", launched: 1999,
    instruments: "MODIS, ASTER, MISR, CERES, MOPITT",
    purpose: "Flagship of NASA's Earth Observing System. MODIS images the whole planet every 1–2 days.",
    disaster: "MODIS thermal anomalies feed NASA FIRMS, the global active-fire map." },
  { id: "aqua", name: "Aqua", cat: "optical", alt: 705, inc: 98.2, raan: 240, phase: 300,
    operator: "NASA", launched: 2002,
    instruments: "MODIS, AIRS, AMSR-E (retired), CERES",
    purpose: "Studies the water cycle: clouds, sea-surface temperature, humidity, sea ice.",
    disaster: "Afternoon MODIS pass complements Terra for daily fire and flood monitoring." },
  { id: "snpp", name: "Suomi NPP", cat: "optical", alt: 824, inc: 98.7, raan: 250, phase: 20,
    operator: "NASA / NOAA", launched: 2011,
    instruments: "VIIRS, ATMS, CrIS, OMPS",
    purpose: "Polar weather and climate observer. VIIRS has a low-light Day/Night Band.",
    disaster: "Detects small fires at 375 m and maps power outages from city lights at night." },
  { id: "noaa20", name: "NOAA-20", cat: "optical", alt: 824, inc: 98.7, raan: 250, phase: 200,
    operator: "NOAA", launched: 2017,
    instruments: "VIIRS, ATMS, CrIS",
    purpose: "Operational polar-orbiting weather satellite (JPSS-1).",
    disaster: "VIIRS fire detections and flood maps; microwave soundings for hurricane forecasts." },
  { id: "noaa21", name: "NOAA-21", cat: "optical", alt: 824, inc: 98.7, raan: 250, phase: 110,
    operator: "NOAA", launched: 2022,
    instruments: "VIIRS, ATMS, CrIS, OMPS",
    purpose: "Newest JPSS polar weather satellite, sharing the orbit with NOAA-20 and Suomi NPP.",
    disaster: "Same fire, flood and storm role as NOAA-20." },
  { id: "wv3", name: "WorldView-3", cat: "optical", alt: 617, inc: 97.9, raan: 300, phase: 60,
    operator: "Maxar", launched: 2014,
    instruments: "31 cm panchromatic, multispectral & SWIR",
    purpose: "Very-high-resolution commercial imagery that can resolve individual cars.",
    disaster: "Building-by-building damage assessment after earthquakes and storms." },
  { id: "dove", name: "PlanetScope (Dove)", cat: "optical", alt: 475, inc: 97.4, raan: 160, phase: 250,
    operator: "Planet Labs", launched: 2016,
    instruments: "~3 m 8-band imager on CubeSats",
    purpose: "A fleet of 100+ shoebox-sized satellites imaging all land on Earth roughly daily.",
    disaster: "Daily snapshots show how a flood or fire evolves day to day." },

  // ── Radar & altimetry ──────────────────────────────────────────────────────
  { id: "s1a", name: "Sentinel-1A", cat: "radar", alt: 693, inc: 98.2, raan: 80, phase: 10,
    operator: "ESA / Copernicus", launched: 2014,
    instruments: "C-band SAR",
    purpose: "All-weather, day-and-night radar imaging of land and ocean on a 12-day repeat.",
    disaster: "Workhorse of flood mapping and InSAR earthquake deformation maps." },
  { id: "s1c", name: "Sentinel-1C", cat: "radar", alt: 693, inc: 98.2, raan: 80, phase: 190,
    operator: "ESA / Copernicus", launched: 2024,
    instruments: "C-band SAR, AIS ship receiver",
    purpose: "Restores the two-satellite Sentinel-1 constellation for a 6-day repeat.",
    disaster: "Faster revisit means flood maps within hours of an overpass." },
  { id: "nisar", name: "NISAR", cat: "radar", alt: 747, inc: 98.4, raan: 200, phase: 140,
    operator: "NASA / ISRO", launched: 2025,
    instruments: "L-band and S-band SAR",
    purpose: "Dual-frequency radar mapping all land and ice every 12 days.",
    disaster: "Measures centimetre-scale ground motion from earthquakes, volcanoes and landslides." },
  { id: "alos2", name: "ALOS-2", cat: "radar", alt: 628, inc: 97.9, raan: 340, phase: 70,
    operator: "JAXA", launched: 2014,
    instruments: "PALSAR-2 L-band SAR",
    purpose: "Long-wavelength radar that penetrates vegetation canopy.",
    disaster: "Japan's primary emergency-observation satellite for quakes and floods." },
  { id: "rcm", name: "RADARSAT Constellation", cat: "radar", alt: 600, inc: 97.7, raan: 40, phase: 280,
    operator: "Canadian Space Agency", launched: 2019,
    instruments: "C-band SAR on three satellites",
    purpose: "Daily coverage of Canada's land, coasts and Arctic waters.",
    disaster: "Flood and ice-jam monitoring; contributes to the International Disasters Charter." },
  { id: "iceye", name: "ICEYE", cat: "radar", alt: 560, inc: 97.7, raan: 280, phase: 330,
    operator: "ICEYE", launched: 2018,
    instruments: "X-band SAR on small satellites",
    purpose: "Commercial constellation of microsatellite radars with frequent revisits.",
    disaster: "Near-real-time flood depth and extent products for insurers and responders." },
  { id: "swot", name: "SWOT", cat: "radar", alt: 891, inc: 77.6, raan: 130, phase: 20,
    operator: "NASA / CNES", launched: 2022,
    instruments: "KaRIn Ka-band radar interferometer",
    purpose: "First global survey of surface water height in rivers, lakes and oceans.",
    disaster: "Tracks river levels and flood-plain storage across whole basins." },

  // ── Weather ────────────────────────────────────────────────────────────────
  { id: "goes19", name: "GOES-19 (GOES-East)", cat: "weather", geo: true, lng: -75.2,
    operator: "NOAA", launched: 2024,
    instruments: "ABI imager, GLM lightning mapper",
    purpose: "Watches the Americas and Atlantic, refreshing full-disk images every 10 minutes.",
    disaster: "Primary eye on Atlantic hurricanes; detects fire hot spots within minutes." },
  { id: "goes18", name: "GOES-18 (GOES-West)", cat: "weather", geo: true, lng: -137.0,
    operator: "NOAA", launched: 2022,
    instruments: "ABI imager, GLM lightning mapper",
    purpose: "Covers the western US, Alaska, Hawaii and the eastern Pacific.",
    disaster: "Tracks Pacific hurricanes and western-US wildfire smoke plumes." },
  { id: "himawari9", name: "Himawari-9", cat: "weather", geo: true, lng: 140.7,
    operator: "JMA", launched: 2016,
    instruments: "AHI 16-band imager",
    purpose: "Japan's geostationary weather satellite covering East Asia and the western Pacific.",
    disaster: "Typhoon tracking with 2.5-minute rapid scans around Japan." },
  { id: "mtg", name: "Meteosat-12 (MTG-I1)", cat: "weather", geo: true, lng: 0.0,
    operator: "EUMETSAT", launched: 2022,
    instruments: "FCI imager, Lightning Imager",
    purpose: "Third-generation Meteosat watching Europe and Africa.",
    disaster: "Severe-storm nowcasting and lightning detection over Europe and Africa." },
  { id: "met9", name: "Meteosat-9 (IODC)", cat: "weather", geo: true, lng: 45.5,
    operator: "EUMETSAT", launched: 2005,
    instruments: "SEVIRI imager",
    purpose: "Indian Ocean coverage service from over the Horn of Africa.",
    disaster: "Monitors cyclones in the Arabian Sea and Bay of Bengal." },
  { id: "insat", name: "INSAT-3DR", cat: "weather", geo: true, lng: 74.0,
    operator: "ISRO", launched: 2016,
    instruments: "Imager and sounder",
    purpose: "India's meteorological satellite over the Indian subcontinent.",
    disaster: "Feeds India Meteorological Department cyclone warnings." },
  { id: "fy4b", name: "Fengyun-4B", cat: "weather", geo: true, lng: 105.0,
    operator: "CMA", launched: 2021,
    instruments: "AGRI imager, GIIRS sounder",
    purpose: "China's second-generation geostationary weather satellite.",
    disaster: "Typhoon and heavy-rain monitoring over Asia." },
  { id: "metopc", name: "Metop-C", cat: "weather", alt: 817, inc: 98.7, raan: 190, phase: 50,
    operator: "EUMETSAT", launched: 2018,
    instruments: "ASCAT scatterometer, IASI, AVHRR",
    purpose: "Polar-orbiting European weather satellite in a morning orbit.",
    disaster: "ASCAT measures ocean surface winds to locate cyclone centres." },
  { id: "gpm", name: "GPM Core Observatory", cat: "weather", alt: 407, inc: 65, raan: 90, phase: 200,
    operator: "NASA / JAXA", launched: 2014,
    instruments: "Dual-frequency Precipitation Radar, GMI",
    purpose: "Measures rain and snow in 3D, calibrating a global precipitation constellation.",
    disaster: "Looks inside cyclones for rainfall rates; drives flood forecasts." },

  // ── Communications ─────────────────────────────────────────────────────────
  ...[0, 1, 2, 3, 4, 5].map((k) => ({
    id: `starlink${k}`, name: `Starlink (shell 1, sample ${k + 1})`, cat: "comms",
    alt: 550, inc: 53, raan: k * 60, phase: k * 47,
    operator: "SpaceX", launched: 2019,
    instruments: "Ku/Ka-band phased-array antennas, laser links",
    purpose: "One of thousands of broadband satellites in low Earth orbit; only a few are drawn here.",
    disaster: "Portable terminals restore internet for responders when cell towers are down.",
  })),
  { id: "iridium1", name: "Iridium NEXT", cat: "comms", alt: 780, inc: 86.4, raan: 0, phase: 30,
    operator: "Iridium", launched: 2017,
    instruments: "L-band voice/data, cross-links",
    purpose: "66-satellite constellation giving truly global coverage, poles included.",
    disaster: "Satellite phones that work when terrestrial networks fail." },
  { id: "iridium2", name: "Iridium NEXT", cat: "comms", alt: 780, inc: 86.4, raan: 90, phase: 170,
    operator: "Iridium", launched: 2017,
    instruments: "L-band voice/data, cross-links",
    purpose: "66-satellite constellation giving truly global coverage, poles included.",
    disaster: "Satellite phones that work when terrestrial networks fail." },
  { id: "intelsat", name: "Intelsat 35e", cat: "comms", geo: true, lng: -34.5,
    operator: "Intelsat", launched: 2017,
    instruments: "C- and Ku-band high-throughput payload",
    purpose: "Geostationary relay for broadcast and broadband across the Atlantic region.",
    disaster: "Backhaul for emergency networks across the Americas, Europe and Africa." },

  // ── Navigation ─────────────────────────────────────────────────────────────
  ...[0, 1, 2, 3].map((k) => ({
    id: `gps${k}`, name: `GPS satellite (plane ${"ACEF"[k]})`, cat: "nav",
    alt: 20200, inc: 55, raan: k * 90 + 15, phase: k * 80,
    operator: "US Space Force", launched: 1978,
    instruments: "L1/L2/L5 navigation signals, atomic clocks",
    purpose: "About 31 operational satellites in six planes provide positioning and timing worldwide.",
    disaster: "Ground GNSS stations measure how far the crust jumped in an earthquake.",
  })),
  { id: "galileo", name: "Galileo", cat: "nav", alt: 23222, inc: 56, raan: 200, phase: 40,
    operator: "EU / ESA", launched: 2011,
    instruments: "E1/E5/E6 navigation signals, search-and-rescue transponder",
    purpose: "Europe's global navigation system.",
    disaster: "Relays distress beacons and sends acknowledgements back to people in trouble." },
  { id: "glonass", name: "GLONASS", cat: "nav", alt: 19100, inc: 64.8, raan: 320, phase: 220,
    operator: "Roscosmos", launched: 1982,
    instruments: "L-band navigation signals",
    purpose: "Russia's global navigation system, strong coverage at high latitudes.",
    disaster: "Adds satellites to multi-GNSS crustal deformation networks." },

  // ── Crewed ─────────────────────────────────────────────────────────────────
  { id: "iss", name: "International Space Station", cat: "crewed", alt: 420, inc: 51.64, raan: 140, phase: 100,
    operator: "NASA / Roscosmos / ESA / JAXA / CSA", launched: 1998,
    instruments: "Handheld cameras, ECOSTRESS, GEDI, LIS",
    purpose: "Crewed laboratory circling Earth about every 92 minutes.",
    disaster: "Crew photograph unfolding disasters; ECOSTRESS maps heat stress and fire risk." },
  { id: "tiangong", name: "Tiangong", cat: "crewed", alt: 390, inc: 41.5, raan: 300, phase: 10,
    operator: "CMSA", launched: 2021,
    instruments: "Science racks, Earth-observation cameras",
    purpose: "China's modular space station.",
    disaster: "Astronaut photography and experimental Earth-observation payloads." },
];

const GEO_ALT_KM = 35786;

/* Altitude used for drawing. Real LEO→GEO spans 400–36,000 km, which would put
 * GEO satellites behind the camera, so the scale is compressed above LEO. */
function displayAltitude(altKm) {
  if (altKm < 2000) return 0.035 + (altKm / EARTH_RADIUS_KM) * 1.1;
  if (altKm < 30000) return 0.75 + (altKm - 19000) / 40000;
  return 1.25;
}

function gmst(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const t = (jd - 2451545.0) / 36525;
  let g = 280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * t * t;
  g = ((g % 360) + 360) % 360;
  return g * DEG;
}

function wrapLng(lng) {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/* Earth-fixed lat/lng (deg) of a satellite at the argument of latitude u (rad). */
function subPoint(sat, u, theta) {
  const i = sat.inc * DEG;
  const o = sat.raan * DEG;
  const x = Math.cos(o) * Math.cos(u) - Math.sin(o) * Math.sin(u) * Math.cos(i);
  const y = Math.sin(o) * Math.cos(u) + Math.cos(o) * Math.sin(u) * Math.cos(i);
  const z = Math.sin(u) * Math.sin(i);
  const lat = Math.asin(z) / DEG;
  const lng = wrapLng((Math.atan2(y, x) - theta) / DEG);
  return { lat, lng };
}

function meanMotion(altKm) {
  const a = EARTH_RADIUS_KM + altKm;
  return Math.sqrt(MU / (a * a * a));
}

function periodMinutes(sat) {
  const altKm = sat.geo ? GEO_ALT_KM : sat.alt;
  return (2 * Math.PI) / meanMotion(altKm) / 60;
}

/* Position of a satellite at simulated time `date`. */
function propagate(sat, date) {
  if (sat.geo) return { lat: 0, lng: sat.lng, altKm: GEO_ALT_KM };
  const t = date.getTime() / 1000;
  const u = sat.phase * DEG + meanMotion(sat.alt) * t;
  const { lat, lng } = subPoint(sat, u, gmst(date));
  return { lat, lng, altKm: sat.alt };
}

/* One full orbit as [lat, lng, displayAlt] points, longitudes unwrapped so
 * consecutive points never jump across the antimeridian. */
function orbitPath(sat, date, steps = 180) {
  const alt = displayAltitude(sat.geo ? GEO_ALT_KM : sat.alt);
  const pts = [];
  if (sat.geo) {
    for (let k = 0; k <= steps; k++) pts.push([0, -180 + (360 * k) / steps, alt]);
    return pts;
  }
  const theta = gmst(date);
  let prev = null;
  for (let k = 0; k <= steps; k++) {
    const u = (2 * Math.PI * k) / steps;
    let { lat, lng } = subPoint(sat, u, theta);
    if (prev !== null) {
      while (lng - prev > 180) lng -= 360;
      while (lng - prev < -180) lng += 360;
    }
    prev = lng;
    pts.push([lat, lng, alt]);
  }
  return pts;
}

/* Ground radius (deg) a satellite can see above a minimum elevation angle. */
function footprintRadiusDeg(altKm, minElevDeg = 10) {
  const e = minElevDeg * DEG;
  const ratio = EARTH_RADIUS_KM / (EARTH_RADIUS_KM + altKm);
  return (Math.acos(ratio * Math.cos(e)) - e) / DEG;
}

function centralAngleDeg(lat1, lng1, lat2, lng2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lng2 - lng1) * DEG;
  const c = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  return Math.acos(Math.min(1, Math.max(-1, c))) / DEG;
}

/* Circle of `radiusDeg` around a point, as path points on the surface. */
function circlePath(lat, lng, radiusDeg, steps = 96) {
  const p = lat * DEG, l = lng * DEG, r = radiusDeg * DEG;
  const pts = [];
  let prev = null;
  for (let k = 0; k <= steps; k++) {
    const b = (2 * Math.PI * k) / steps;
    const lat2 = Math.asin(Math.sin(p) * Math.cos(r) + Math.cos(p) * Math.sin(r) * Math.cos(b));
    let lng2 = (l + Math.atan2(Math.sin(b) * Math.sin(r) * Math.cos(p),
                               Math.cos(r) - Math.sin(p) * Math.sin(lat2))) / DEG;
    if (prev !== null) {
      while (lng2 - prev > 180) lng2 -= 360;
      while (lng2 - prev < -180) lng2 += 360;
    }
    prev = lng2;
    pts.push([lat2 / DEG, lng2, 0.004]);
  }
  return pts;
}

/* Approximate subsolar point, good to a fraction of a degree. */
function subsolarPoint(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = L + 1.915 * DEG * Math.sin(g) + 0.02 * DEG * Math.sin(2 * g);
  const eps = 23.439 * DEG;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const lng = wrapLng((ra - gmst(date)) / DEG);
  return { lat: dec / DEG, lng };
}

window.Orbits = {
  CATEGORIES, SATELLITES, EARTH_RADIUS_KM, GEO_ALT_KM,
  displayAltitude, propagate, orbitPath, periodMinutes,
  footprintRadiusDeg, centralAngleDeg, circlePath, subsolarPoint, wrapLng,
};
