// Position du Soleil d'après les formules publiées par la NOAA (Global Monitoring Laboratory, « Solar Calculation
// Details », d'après Meeus, Astronomical Algorithms) : précision d'environ une minute d'arc entre −2000 et +3000 pour
// les latitudes de ±72°, et utilisable partout (soleil de minuit, nuit polaire, hémisphère sud). La hauteur rendue est
// apparente (réfraction atmosphérique comprise, comme dans le calculateur de la NOAA). Aucune dépendance ; aucun fuseau
// horaire lu dans le navigateur : l'heure du site est l'heure UTC décalée de `utcOffset` heures.

const RAD = Math.PI / 180;

export interface SunPosition {
  /** Hauteur apparente au-dessus de l'horizon (°), négative sous l'horizon. */
  elevation: number;
  /** Azimut (°) compté depuis le nord, dans le sens horaire (90 : est). */
  azimuth: number;
}

/** Équation du temps (min) et déclinaison (°) à un instant donné (siècles juliens depuis J2000). */
function solarTerms(julianCentury: number): { equationOfTime: number; declination: number } {
  const t = julianCentury;
  const meanLongitude = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const centre = Math.sin(meanAnomaly * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + Math.sin(2 * meanAnomaly * RAD) * (0.019993 - 0.000101 * t)
    + Math.sin(3 * meanAnomaly * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const apparentLongitude = meanLongitude + centre - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const meanObliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(omega * RAD);
  const declination = Math.asin(Math.sin(obliquity * RAD) * Math.sin(apparentLongitude * RAD)) / RAD;
  const y = Math.tan((obliquity / 2) * RAD) ** 2;
  const l0 = meanLongitude * RAD, m = meanAnomaly * RAD;
  const equationOfTime = (4 / RAD) * (y * Math.sin(2 * l0) - 2 * eccentricity * Math.sin(m) + 4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0)
    - 0.5 * y * y * Math.sin(4 * l0) - 1.25 * eccentricity * eccentricity * Math.sin(2 * m));
  return { equationOfTime, declination };
}

const julianCentury = (date: Date): number => (date.getTime() / 86_400_000 + 2440587.5 - 2451545) / 36525;

/** Réfraction atmosphérique (°) pour une hauteur géométrique `elevation` (°), formule de la NOAA. */
function refraction(elevation: number): number {
  if (elevation > 85) return 0;
  const tan = Math.tan(elevation * RAD);
  const seconds = elevation > 5 ? 58.1 / tan - 0.07 / tan ** 3 + 0.000086 / tan ** 5
    : elevation > -0.575 ? 1735 + elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)))
      : -20.772 / tan;
  return seconds / 3600;
}

export function sunPosition(date: Date, latitude: number, longitude: number): SunPosition {
  const { equationOfTime, declination } = solarTerms(julianCentury(date));
  const utcMinutes = (((date.getTime() / 60_000) % 1440) + 1440) % 1440;
  const trueSolarTime = (((utcMinutes + equationOfTime + 4 * longitude) % 1440) + 1440) % 1440;
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;
  const phi = latitude * RAD, delta = declination * RAD, h = hourAngle * RAD;
  const cosZenith = Math.min(1, Math.max(-1, Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(h)));
  const zenith = Math.acos(cosZenith);
  const geometric = 90 - zenith / RAD;
  // Azimut depuis le nord, sens horaire ; aux pôles et au zénith, la formule de la NOAA dégénère : le sens de l'angle horaire suffit.
  const denominator = Math.cos(phi) * Math.sin(zenith);
  let azimuth: number;
  if (Math.abs(denominator) < 1e-12) azimuth = hourAngle > 0 ? 0 : 180;
  else {
    const cosAzimuth = Math.min(1, Math.max(-1, (Math.sin(phi) * Math.cos(zenith) - Math.sin(delta)) / denominator));
    const angle = Math.acos(cosAzimuth) / RAD;
    azimuth = hourAngle > 0 ? (angle + 180) % 360 : (540 - angle) % 360;
  }
  return { elevation: geometric + refraction(geometric), azimuth };
}

/** Vecteur unitaire vers le Soleil : est, nord, haut. */
export function sunVector({ elevation, azimuth }: SunPosition): [number, number, number] {
  const e = elevation * RAD, a = azimuth * RAD;
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
}

const dayStart = (day: string): number => {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, date);
};

/** L'instant (UTC) d'une heure locale du site : `minutes` depuis minuit, le jour `day` (AAAA-MM-JJ), à UTC + `utcOffset` h. */
export const localTime = (day: string, minutes: number, utcOffset: number): Date => new Date(dayStart(day) + (minutes - utcOffset * 60) * 60_000);

/** Midi solaire vrai (UTC) d'un jour à cette longitude, l'équation du temps prise à cet instant (deux passes). */
export function solarNoon(day: string, longitude: number): Date {
  let minutes = 720 - 4 * longitude;
  for (let pass = 0; pass < 2; pass++) minutes = 720 - 4 * longitude - solarTerms(julianCentury(new Date(dayStart(day) + minutes * 60_000))).equationOfTime;
  return new Date(dayStart(day) + minutes * 60_000);
}

/** Décalage horaire par défaut, d'après la longitude seule (15° par heure) : l'heure légale du pays peut différer. */
export const defaultUtcOffset = (longitude: number): number => Math.round(longitude / 15) + 0;

export interface SunSample {
  /** Minute locale du milieu de l'intervalle. */
  minutes: number;
  /** Vers le Soleil : est, nord, haut. */
  direction: [number, number, number];
  /** Durée que l'échantillon représente (h). */
  hours: number;
}

/**
 * La course du Soleil sur un jour (heure locale du site, de 0 h à 24 h), échantillonnée au milieu de pas de `stepMinutes` :
 * seuls les échantillons au-dessus de l'horizon sont rendus. Un nombre borné de positions (144 au plus par défaut).
 */
export function daySunPath(day: string, latitude: number, longitude: number, utcOffset: number, stepMinutes = 10): SunSample[] {
  const samples: SunSample[] = [];
  for (let start = 0; start < 1440; start += stepMinutes) {
    const minutes = start + stepMinutes / 2;
    const position = sunPosition(localTime(day, minutes, utcOffset), latitude, longitude);
    if (position.elevation > 0) samples.push({ minutes, direction: sunVector(position), hours: stepMinutes / 60 });
  }
  return samples;
}

/** Jours usuels d'une étude d'ombres : équinoxes et solstices (dates conventionnelles, à un jour près selon l'année). */
export function presetDays(year: number): { label: string; day: string }[] {
  return [
    { label: 'Équinoxe de mars', day: `${year}-03-20` },
    { label: 'Solstice de juin', day: `${year}-06-21` },
    { label: 'Équinoxe de septembre', day: `${year}-09-22` },
    { label: 'Solstice de décembre', day: `${year}-12-21` },
  ];
}
