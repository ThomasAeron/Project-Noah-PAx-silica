import { Router } from 'express';

export const locationRouter = Router();

const lookupRequests = new Map();
const lookupRateLimit = (req, res, next) => {
  const now = Date.now();
  const recent = (lookupRequests.get(req.ip) || []).filter((timestamp) => now - timestamp < 60_000);
  if (recent.length >= 10) {
    return res.status(429).json({ error: 'Too many address lookups. Please wait a minute before trying again.' });
  }
  recent.push(now);
  lookupRequests.set(req.ip, recent);
  next();
};

const caintaAreas = {
  Junction: { lat: 14.5785, lon: 121.1130 },
  'San Isidro': { lat: 14.5835, lon: 121.1110 },
  Brookside: { lat: 14.5812, lon: 121.1048 },
  'Sto. Domingo': { lat: 14.6000, lon: 121.1090 },
  Karangalan: { lat: 14.6280, lon: 121.1080 }
};

locationRouter.post('/lookup', lookupRateLimit, async (req, res) => {
  const { area, address } = req.body || {};
  if (!Object.hasOwn(caintaAreas, area) || typeof address !== 'string' || address.trim().length < 3 || address.length > 200) {
    return res.status(400).json({ error: 'Choose a Cainta area and enter address details between 3 and 200 characters.' });
  }

  const [[minLat, minLon], [maxLat, maxLon]] = [[14.547851, 121.0946307], [14.6365632, 121.1450774]];
  const center = caintaAreas[area];
  const query = new URLSearchParams({
    q: `${address.trim()}, ${area}, Cainta, Rizal, Philippines`,
    limit: '5',
    lat: String(center.lat),
    lon: String(center.lon),
    bbox: [minLon, minLat, maxLon, maxLat].join(',')
  });

  try {
    const response = await fetch(`https://photon.komoot.io/api/?${query}`, {
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) {
      return res.status(502).json({ error: 'Address lookup is temporarily unavailable. Please try again later.' });
    }
    const result = await response.json();
    if (!Array.isArray(result.features)) {
      return res.status(502).json({ error: 'Address lookup returned an invalid response. Please try again later.' });
    }
    res.json({ features: result.features });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError';
    res.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? 'Address lookup took too long. Please try again.'
        : 'Address lookup is temporarily unavailable. Please try again later.'
    });
  }
});
