// Le fuseau horaire d'un lieu, trouvé sans service : le pays (donné par la recherche de lieu) et, pour les pays à
// plusieurs fuseaux, le fuseau dont la ville repère est la plus proche. Le décalage d'un jour donné (heure d'été
// comprise) vient ensuite du navigateur (Intl), qui connaît les règles de chaque fuseau. C'est une estimation près des
// limites de fuseaux : la page la montre comme « heure de <ville> » et l'utilisateur peut la corriger.

/** Pays → fuseau (IANA), ou fuseaux avec une ville repère (latitude, longitude) chacun. */
const ZONES: Record<string, string | [string, number, number][]> = {
  ad: 'Europe/Andorra', ae: 'Asia/Dubai', af: 'Asia/Kabul', ag: 'America/Antigua', ai: 'America/Anguilla', al: 'Europe/Tirane',
  am: 'Asia/Yerevan', ao: 'Africa/Luanda', ar: 'America/Argentina/Buenos_Aires', as: 'Pacific/Pago_Pago', at: 'Europe/Vienna',
  aw: 'America/Aruba', ax: 'Europe/Mariehamn', az: 'Asia/Baku', ba: 'Europe/Sarajevo', bb: 'America/Barbados', bd: 'Asia/Dhaka',
  be: 'Europe/Brussels', bf: 'Africa/Ouagadougou', bg: 'Europe/Sofia', bh: 'Asia/Bahrain', bi: 'Africa/Bujumbura', bj: 'Africa/Porto-Novo',
  bl: 'America/St_Barthelemy', bm: 'Atlantic/Bermuda', bn: 'Asia/Brunei', bo: 'America/La_Paz', bq: 'America/Kralendijk',
  bs: 'America/Nassau', bt: 'Asia/Thimphu', bw: 'Africa/Gaborone', by: 'Europe/Minsk', bz: 'America/Belize', cc: 'Indian/Cocos',
  cf: 'Africa/Bangui', cg: 'Africa/Brazzaville', ch: 'Europe/Zurich', ci: 'Africa/Abidjan', ck: 'Pacific/Rarotonga', cm: 'Africa/Douala',
  cn: 'Asia/Shanghai', co: 'America/Bogota', cr: 'America/Costa_Rica', cu: 'America/Havana', cv: 'Atlantic/Cape_Verde',
  cw: 'America/Curacao', cx: 'Indian/Christmas', cy: 'Asia/Nicosia', cz: 'Europe/Prague', de: 'Europe/Berlin', dj: 'Africa/Djibouti',
  dk: 'Europe/Copenhagen', dm: 'America/Dominica', do: 'America/Santo_Domingo', dz: 'Africa/Algiers', ee: 'Europe/Tallinn',
  eg: 'Africa/Cairo', eh: 'Africa/El_Aaiun', er: 'Africa/Asmara', et: 'Africa/Addis_Ababa', fi: 'Europe/Helsinki', fj: 'Pacific/Fiji',
  fk: 'Atlantic/Stanley', fo: 'Atlantic/Faroe', ga: 'Africa/Libreville', gb: 'Europe/London', gd: 'America/Grenada', ge: 'Asia/Tbilisi',
  gf: 'America/Cayenne', gg: 'Europe/Guernsey', gh: 'Africa/Accra', gi: 'Europe/Gibraltar', gm: 'Africa/Banjul', gn: 'Africa/Conakry',
  gp: 'America/Guadeloupe', gq: 'Africa/Malabo', gr: 'Europe/Athens', gs: 'Atlantic/South_Georgia', gt: 'America/Guatemala',
  gu: 'Pacific/Guam', gw: 'Africa/Bissau', gy: 'America/Guyana', hk: 'Asia/Hong_Kong', hn: 'America/Tegucigalpa', hr: 'Europe/Zagreb',
  ht: 'America/Port-au-Prince', hu: 'Europe/Budapest', ie: 'Europe/Dublin', il: 'Asia/Jerusalem', im: 'Europe/Isle_of_Man',
  in: 'Asia/Kolkata', io: 'Indian/Chagos', iq: 'Asia/Baghdad', ir: 'Asia/Tehran', is: 'Atlantic/Reykjavik', it: 'Europe/Rome',
  je: 'Europe/Jersey', jm: 'America/Jamaica', jo: 'Asia/Amman', jp: 'Asia/Tokyo', ke: 'Africa/Nairobi', kg: 'Asia/Bishkek',
  kh: 'Asia/Phnom_Penh', km: 'Indian/Comoro', kn: 'America/St_Kitts', kp: 'Asia/Pyongyang', kr: 'Asia/Seoul', kw: 'Asia/Kuwait',
  ky: 'America/Cayman', kz: 'Asia/Almaty', la: 'Asia/Vientiane', lb: 'Asia/Beirut', lc: 'America/St_Lucia', li: 'Europe/Vaduz',
  lk: 'Asia/Colombo', lr: 'Africa/Monrovia', ls: 'Africa/Maseru', lt: 'Europe/Vilnius', lu: 'Europe/Luxembourg', lv: 'Europe/Riga',
  ly: 'Africa/Tripoli', ma: 'Africa/Casablanca', mc: 'Europe/Monaco', md: 'Europe/Chisinau', me: 'Europe/Podgorica', mf: 'America/Marigot',
  mg: 'Indian/Antananarivo', mh: 'Pacific/Majuro', mk: 'Europe/Skopje', ml: 'Africa/Bamako', mm: 'Asia/Yangon', mo: 'Asia/Macau',
  mp: 'Pacific/Saipan', mq: 'America/Martinique', mr: 'Africa/Nouakchott', ms: 'America/Montserrat', mt: 'Europe/Malta',
  mu: 'Indian/Mauritius', mv: 'Indian/Maldives', mw: 'Africa/Blantyre', my: 'Asia/Kuala_Lumpur', mz: 'Africa/Maputo',
  na: 'Africa/Windhoek', nc: 'Pacific/Noumea', ne: 'Africa/Niamey', nf: 'Pacific/Norfolk', ng: 'Africa/Lagos', ni: 'America/Managua',
  nl: 'Europe/Amsterdam', no: 'Europe/Oslo', np: 'Asia/Kathmandu', nr: 'Pacific/Nauru', nu: 'Pacific/Niue', om: 'Asia/Muscat',
  pa: 'America/Panama', pe: 'America/Lima', ph: 'Asia/Manila', pk: 'Asia/Karachi', pl: 'Europe/Warsaw', pm: 'America/Miquelon',
  pn: 'Pacific/Pitcairn', pr: 'America/Puerto_Rico', ps: 'Asia/Gaza', pw: 'Pacific/Palau', py: 'America/Asuncion', qa: 'Asia/Qatar',
  re: 'Indian/Reunion', ro: 'Europe/Bucharest', rs: 'Europe/Belgrade', rw: 'Africa/Kigali', sa: 'Asia/Riyadh', sb: 'Pacific/Guadalcanal',
  sc: 'Indian/Mahe', sd: 'Africa/Khartoum', se: 'Europe/Stockholm', sg: 'Asia/Singapore', sh: 'Atlantic/St_Helena', si: 'Europe/Ljubljana',
  sj: 'Arctic/Longyearbyen', sk: 'Europe/Bratislava', sl: 'Africa/Freetown', sm: 'Europe/San_Marino', sn: 'Africa/Dakar',
  so: 'Africa/Mogadishu', sr: 'America/Paramaribo', ss: 'Africa/Juba', st: 'Africa/Sao_Tome', sv: 'America/El_Salvador',
  sx: 'America/Lower_Princes', sy: 'Asia/Damascus', sz: 'Africa/Mbabane', tc: 'America/Grand_Turk', td: 'Africa/Ndjamena',
  tf: 'Indian/Kerguelen', tg: 'Africa/Lome', th: 'Asia/Bangkok', tj: 'Asia/Dushanbe', tk: 'Pacific/Fakaofo', tl: 'Asia/Dili',
  tm: 'Asia/Ashgabat', tn: 'Africa/Tunis', to: 'Pacific/Tongatapu', tr: 'Europe/Istanbul', tt: 'America/Port_of_Spain',
  tv: 'Pacific/Funafuti', tw: 'Asia/Taipei', tz: 'Africa/Dar_es_Salaam', ua: 'Europe/Kiev', ug: 'Africa/Kampala',
  uy: 'America/Montevideo', uz: 'Asia/Tashkent', va: 'Europe/Vatican', vc: 'America/St_Vincent', ve: 'America/Caracas',
  vg: 'America/Tortola', vi: 'America/St_Thomas', vn: 'Asia/Ho_Chi_Minh', vu: 'Pacific/Efate', wf: 'Pacific/Wallis', ws: 'Pacific/Apia',
  xk: 'Europe/Belgrade', ye: 'Asia/Aden', yt: 'Indian/Mayotte', za: 'Africa/Johannesburg', zm: 'Africa/Lusaka', zw: 'Africa/Harare',
  // Pays à plusieurs fuseaux : villes repères.
  au: [['Australia/Sydney', -33.9, 151.2], ['Australia/Melbourne', -37.8, 145], ['Australia/Brisbane', -27.5, 153], ['Australia/Adelaide', -34.9, 138.6],
    ['Australia/Darwin', -12.5, 130.8], ['Australia/Perth', -31.95, 115.9], ['Australia/Hobart', -42.9, 147.3]],
  br: [['America/Sao_Paulo', -23.5, -46.6], ['America/Sao_Paulo', -15.8, -47.9], ['America/Sao_Paulo', -22.9, -43.2], ['America/Bahia', -13, -38.5],
    ['America/Fortaleza', -3.7, -38.5], ['America/Recife', -8.05, -34.9], ['America/Belem', -1.46, -48.5], ['America/Manaus', -3.1, -60],
    ['America/Cuiaba', -15.6, -56.1], ['America/Porto_Velho', -8.76, -63.9], ['America/Rio_Branco', -9.97, -67.8], ['America/Noronha', -3.85, -32.4]],
  ca: [['America/St_Johns', 47.6, -52.7], ['America/Halifax', 44.6, -63.6], ['America/Toronto', 43.7, -79.4], ['America/Toronto', 45.5, -73.6],
    ['America/Winnipeg', 49.9, -97.1], ['America/Regina', 50.4, -104.6], ['America/Edmonton', 53.5, -113.5], ['America/Edmonton', 51, -114.1],
    ['America/Vancouver', 49.3, -123.1], ['America/Whitehorse', 60.7, -135.1], ['America/Iqaluit', 63.7, -68.5]],
  cd: [['Africa/Kinshasa', -4.3, 15.3], ['Africa/Lubumbashi', -11.7, 27.5], ['Africa/Lubumbashi', -1.7, 29.2]],
  cl: [['America/Santiago', -33.45, -70.65], ['America/Punta_Arenas', -53.2, -70.9], ['Pacific/Easter', -27.1, -109.4]],
  ec: [['America/Guayaquil', -2.2, -79.9], ['America/Guayaquil', -0.2, -78.5], ['Pacific/Galapagos', -0.9, -89.6]],
  es: [['Europe/Madrid', 40.4, -3.7], ['Europe/Madrid', 41.4, 2.2], ['Atlantic/Canary', 28.1, -15.4], ['Africa/Ceuta', 35.9, -5.3]],
  fm: [['Pacific/Chuuk', 7.4, 151.8], ['Pacific/Pohnpei', 6.9, 158.2], ['Pacific/Kosrae', 5.3, 163]],
  // Les départements et collectivités d'outre-mer peuvent arriver sous le code de la France.
  fr: [['Europe/Paris', 46.6, 2.4], ['America/Guadeloupe', 16.2, -61.5], ['America/Martinique', 14.6, -61], ['America/Cayenne', 4, -53],
    ['Indian/Reunion', -21.1, 55.5], ['Indian/Mayotte', -12.8, 45.2], ['Pacific/Noumea', -21.3, 165.5], ['Pacific/Tahiti', -17.6, -149.4],
    ['America/Miquelon', 46.8, -56.2], ['Pacific/Wallis', -13.3, -176.2]],
  gl: [['America/Nuuk', 64.2, -51.7], ['America/Danmarkshavn', 76.8, -18.7], ['America/Scoresbysund', 70.5, -22], ['America/Thule', 76.5, -68.7]],
  id: [['Asia/Jakarta', -6.2, 106.8], ['Asia/Jakarta', -7.25, 112.75], ['Asia/Jakarta', 3.6, 98.7], ['Asia/Pontianak', -0.03, 109.3],
    ['Asia/Makassar', -5.1, 119.4], ['Asia/Makassar', -8.65, 115.2], ['Asia/Jayapura', -2.5, 140.7]],
  ki: [['Pacific/Tarawa', 1.4, 173], ['Pacific/Kanton', -2.8, -171.7], ['Pacific/Kiritimati', 1.9, -157.4]],
  mn: [['Asia/Ulaanbaatar', 47.9, 106.9], ['Asia/Hovd', 48, 91.6]],
  mx: [['America/Mexico_City', 19.4, -99.1], ['America/Monterrey', 25.7, -100.3], ['America/Cancun', 21.2, -86.8], ['America/Chihuahua', 28.6, -106.1],
    ['America/Mazatlan', 23.2, -106.4], ['America/Hermosillo', 29.1, -111], ['America/Tijuana', 32.5, -117]],
  nz: [['Pacific/Auckland', -36.85, 174.8], ['Pacific/Auckland', -43.5, 172.6], ['Pacific/Chatham', -43.95, -176.55]],
  pf: [['Pacific/Tahiti', -17.5, -149.6], ['Pacific/Marquesas', -9, -140], ['Pacific/Gambier', -23.1, -135]],
  pg: [['Pacific/Port_Moresby', -9.4, 147.2], ['Pacific/Bougainville', -6.2, 155.5]],
  pt: [['Europe/Lisbon', 38.7, -9.1], ['Europe/Lisbon', 41.15, -8.6], ['Atlantic/Azores', 37.7, -25.7], ['Atlantic/Madeira', 32.65, -16.9]],
  ru: [['Europe/Kaliningrad', 54.7, 20.5], ['Europe/Moscow', 55.75, 37.6], ['Europe/Moscow', 59.9, 30.3], ['Europe/Moscow', 45, 39],
    ['Europe/Moscow', 55.8, 49.1], ['Europe/Samara', 53.2, 50.1], ['Asia/Yekaterinburg', 56.8, 60.6], ['Asia/Yekaterinburg', 55.2, 61.4],
    ['Asia/Omsk', 55, 73.4], ['Asia/Novosibirsk', 55, 82.9], ['Asia/Krasnoyarsk', 56, 92.9], ['Asia/Irkutsk', 52.3, 104.3],
    ['Asia/Yakutsk', 62, 129.7], ['Asia/Vladivostok', 43.1, 131.9], ['Asia/Magadan', 59.6, 150.8], ['Asia/Kamchatka', 53, 158.6]],
  us: [['America/New_York', 40.7, -74], ['America/New_York', 33.7, -84.4], ['America/New_York', 25.8, -80.2], ['America/Detroit', 42.3, -83],
    ['America/Chicago', 41.9, -87.6], ['America/Chicago', 29.8, -95.4], ['America/Chicago', 32.8, -96.8], ['America/Chicago', 44.98, -93.3],
    ['America/Chicago', 29.95, -90.07], ['America/Chicago', 39.1, -94.6], ['America/Denver', 39.7, -105], ['America/Denver', 40.76, -111.9],
    ['America/Denver', 35.1, -106.6], ['America/Boise', 43.6, -116.2], ['America/Phoenix', 33.4, -112.1], ['America/Los_Angeles', 34, -118.2],
    ['America/Los_Angeles', 37.8, -122.4], ['America/Los_Angeles', 47.6, -122.3], ['America/Los_Angeles', 45.5, -122.7],
    ['America/Los_Angeles', 36.2, -115.1], ['America/Anchorage', 61.2, -149.9], ['Pacific/Honolulu', 21.3, -157.9]],
};

/** Distance angulaire approchée (degrés), longitudes ramenées autour de 0 (antiméridien). */
function spread(latA: number, lonA: number, latB: number, lonB: number): number {
  const dLon = ((((lonB - lonA + 180) % 360) + 360) % 360) - 180;
  return Math.hypot(latB - latA, dLon * Math.cos(((latA + latB) / 2) * (Math.PI / 180)));
}

/** Le fuseau (IANA) d'un point d'un pays, ou null si le pays est inconnu. */
export function zoneFor(country: string | null | undefined, latitude: number, longitude: number): string | null {
  const entry = country ? ZONES[country.toLowerCase()] : undefined;
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  let best = entry[0][0], distance = Infinity;
  for (const [zone, lat, lon] of entry) {
    const d = spread(latitude, longitude, lat, lon);
    if (d < distance) [best, distance] = [zone, d];
  }
  return best;
}

/** Décalage (h) de ce fuseau à cet instant, heure d'été comprise ; null si le navigateur ne connaît pas le fuseau. */
export function zoneOffset(zone: string, at: Date): number | null {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(at).find((part) => part.type === 'timeZoneName')?.value ?? '';
    if (name === 'GMT') return 0;
    const match = /^GMT([+-−])(\d{1,2})(?::(\d{2}))?$/.exec(name);
    if (!match) return null;
    const value = Number(match[2]) + Number(match[3] ?? 0) / 60;
    return match[1] === '+' ? value : -value;
  } catch {
    return null;
  }
}

/** « Colombo » pour « Asia/Colombo », « Buenos Aires » pour « America/Argentina/Buenos_Aires ». */
export const zoneCity = (zone: string): string => (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
