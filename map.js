// Import Mapbox and D3 as ES modules
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// ---------- Step 1.3: Create the map ----------
// Paste your public token from https://account.mapbox.com (it starts with "pk.")
mapboxgl.accessToken = 'pk.PASTE_YOUR_MAPBOX_TOKEN_HERE';

const STATIONS_URL = 'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';
const TRIPS_URL = 'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv';
const BOSTON_LANES_URL =
  'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson';
const CAMBRIDGE_LANES_URL =
  'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson';

const statusEl = document.getElementById('status');
const setStatus = (text) => (statusEl.textContent = text);

if (mapboxgl.accessToken.includes('PASTE_YOUR')) {
  setStatus('Add your Mapbox token at the top of map.js to load the map.');
}

const map = new mapboxgl.Map({
  container: 'map', // ID of the div where the map renders
  style: 'mapbox://styles/mapbox/light-v11', // light basemap so the data stands out
  center: [-71.09415, 42.36027], // [longitude, latitude], near MIT
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

// One shared style object for both cities' bike lanes (Step 2.3)
const bikeLaneStyle = {
  'line-color': '#32D400',
  'line-width': 3,
  'line-opacity': 0.5,
};

// ---------- Step 5.4: Minute buckets for fast filtering ----------
// One bucket per minute of the day (24 * 60 = 1440)
const departuresByMinute = Array.from({ length: 1440 }, () => []);
const arrivalsByMinute = Array.from({ length: 1440 }, () => []);

// ---------- Helpers ----------
// The course file uses GBFS names (lat, lon, short_name); fall back to the other names just in case
const stationId = (s) => s.short_name ?? s.Number;
const stationLat = (s) => +(s.lat ?? s.Lat);
const stationLon = (s) => +(s.lon ?? s.Long);
const stationName = (s) => s.name ?? s.NAME ?? stationId(s);

function getCoords(station) {
  const point = new mapboxgl.LngLat(stationLon(station), stationLat(station));
  const { x, y } = map.project(point); // handles pan, zoom, and rotation for us
  return { cx: x, cy: y };
}

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

// Trips that started/ended within 60 minutes of `minute`, using the buckets
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat(); // no filter
  }

  // Wrap around midnight with % 1440
  const minMinute = (minute - 60 + 1440) % 1440;
  const maxMinute = (minute + 60) % 1440;

  if (minMinute > maxMinute) {
    const beforeMidnight = tripsByMinute.slice(minMinute);
    const afterMidnight = tripsByMinute.slice(0, maxMinute);
    return beforeMidnight.concat(afterMidnight).flat();
  }
  return tripsByMinute.slice(minMinute, maxMinute).flat();
}

// ---------- Step 4.2 / 5.3: Traffic per station ----------
function computeStationTraffic(stations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );

  return stations.map((station) => {
    const id = stationId(station);
    station.arrivals = arrivals.get(id) ?? 0;
    station.departures = departures.get(id) ?? 0;
    station.totalTraffic = station.arrivals + station.departures;
    return station;
  });
}

// ---------- Step 6.1: Traffic flow color ----------
// 3 discrete colors are easier to read than a continuous scale
const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

// Stations with no trips in the window count as "balanced" instead of NaN
const departureRatio = (d) =>
  d.totalTraffic ? stationFlow(d.departures / d.totalTraffic) : 0.5;

const tooltipText = (d) =>
  `${stationName(d)}\n${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`;

// ---------- Everything that needs the map loaded ----------
map.on('load', async () => {
  // Step 2: Bike lanes
  map.addSource('boston_route', { type: 'geojson', data: BOSTON_LANES_URL });
  map.addLayer({ id: 'bike-lanes-boston', type: 'line', source: 'boston_route', paint: bikeLaneStyle });

  map.addSource('cambridge_route', { type: 'geojson', data: CAMBRIDGE_LANES_URL });
  map.addLayer({ id: 'bike-lanes-cambridge', type: 'line', source: 'cambridge_route', paint: bikeLaneStyle });

  // Step 3.1: Station data
  setStatus('Loading stations…');
  let jsonData;
  try {
    jsonData = await d3.json(STATIONS_URL);
  } catch (error) {
    console.error('Error loading JSON:', error);
    setStatus('Could not load station data.');
    return;
  }

  // Step 4.1: Trip data (~260K rows), parsed and bucketed as it loads
  setStatus('Loading 260,000 trips…');
  let trips;
  try {
    trips = await d3.csv(TRIPS_URL, (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);
      departuresByMinute[minutesSinceMidnight(trip.started_at)].push(trip);
      arrivalsByMinute[minutesSinceMidnight(trip.ended_at)].push(trip);
      return trip;
    });
  } catch (error) {
    console.error('Error loading trips:', error);
    setStatus('Could not load trip data.');
    return;
  }
  console.log(`Loaded ${trips.length} trips`);

  const stations = computeStationTraffic(jsonData.data.stations);

  // Step 4.3: sqrt scale so circle AREA matches traffic
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);

  // Step 3.3: Station markers on the SVG overlay
  const svg = d3.select('#map').select('svg');

  const circles = svg
    .selectAll('circle')
    .data(stations, (d) => stationId(d)) // key so D3 reuses the same circle per station
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .style('--departure-ratio', departureRatio)
    .each(function (d) {
      // Step 4.4: browser tooltip
      d3.select(this).append('title').text(tooltipText(d));
    });

  // Keep markers lined up with the map as it moves
  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx)
      .attr('cy', (d) => getCoords(d).cy);
  }

  updatePositions();
  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('resize', updatePositions);
  map.on('moveend', updatePositions);

  // Step 5.2-5.3: Slider filtering
  const timeSlider = document.getElementById('time-slider');
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  function updateScatterPlot(timeFilter) {
    const filteredStations = computeStationTraffic(stations, timeFilter);

    // Bigger circles when fewer trips are shown, so stations stay visible
    timeFilter === -1 ? radiusScale.range([0, 25]) : radiusScale.range([3, 50]);

    circles
      .data(filteredStations, (d) => stationId(d))
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', departureRatio)
      .select('title')
      .text(tooltipText);
  }

  function updateTimeDisplay() {
    const timeFilter = Number(timeSlider.value);

    if (timeFilter === -1) {
      selectedTime.textContent = '';
      anyTimeLabel.style.display = 'block';
    } else {
      selectedTime.textContent = formatTime(timeFilter);
      anyTimeLabel.style.display = 'none';
    }

    updateScatterPlot(timeFilter);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay();
  setStatus('');
});
