// Durées (en millisecondes) de chaque phase d'une conversion IFC, pour savoir où va le temps.

/** Préparation d'un convertisseur ; vide s'il était déjà prêt. Le chargement des paquets et le téléchargement du fichier IfcOpenShell se recouvrent. */
export interface StartupTimings {
  /** Démarrage de Python (Pyodide). */
  boot?: number;
  /** Chargement des paquets Python (numpy, shapely…). */
  packages?: number;
  /** Récupération du fichier IfcOpenShell, depuis le cache ou le réseau. */
  wheelFetch?: number;
  wheelSource?: 'cache' | 'network';
  /** Installation du paquet IfcOpenShell. */
  install?: number;
  /** Écriture et import des scripts (donc d'IfcOpenShell). */
  import?: number;
  /** Durée totale de la préparation. */
  total?: number;
}

/** Ce que renvoie un convertisseur après une tranche. */
export interface ShardTimings {
  startup: StartupTimings;
  /** Lecture de l'IFC (analyse du fichier). */
  parse: number;
  /** Calcul de la géométrie et écriture du GLB. */
  geometry: number;
}

export interface IfcTimings {
  /** Préparation du convertisseur qui a mis le plus de temps à démarrer ; vide si tous étaient prêts. */
  startup: StartupTimings;
  parse: number;
  geometry: number;
  /** Fusion des tranches en un seul GLB, dans le fil principal. */
  merge: number;
  /** Lecture du fichier depuis le disque. */
  read: number;
}

/** Réunit les durées des tranches (parallèles : la plus longue compte). */
export function combineTimings(shards: ShardTimings[], merge: number, read: number): IfcTimings {
  const startup = shards.reduce<StartupTimings>((slowest, shard) => ((shard.startup.total ?? 0) > (slowest.total ?? 0) ? shard.startup : slowest), {});
  return {
    startup,
    parse: Math.max(0, ...shards.map((shard) => shard.parse)),
    geometry: Math.max(0, ...shards.map((shard) => shard.geometry)),
    merge,
    read,
  };
}

const seconds = (ms: number) => `${(Math.round(ms / 100) / 10).toLocaleString('fr-FR')} s`;

/** Deux courtes phrases pour la carte « IFC converti » : démarrage du moteur, puis le détail de la conversion. */
export function describeTimings(timings: IfcTimings): string {
  const { startup } = timings;
  let engine = 'Moteur déjà prêt.';
  if (startup.total) {
    const steps: [string, number | undefined][] = [
      ['Python', startup.boot],
      ['paquets', startup.packages],
      [`IfcOpenShell ${startup.wheelSource === 'cache' ? 'en cache' : 'téléchargé'}`, startup.wheelFetch],
      ['installation', startup.install],
      ['import', startup.import],
    ];
    const detail = steps.filter((step): step is [string, number] => (step[1] ?? 0) >= 50).map(([name, ms]) => `${name} ${seconds(ms)}`);
    engine = `Démarrage du moteur : ${seconds(startup.total)}${detail.length ? ` (${detail.join(', ')})` : ''}.`;
  }
  return `${engine} Fichier ${seconds(timings.read)}, lecture de l’IFC ${seconds(timings.parse)}, géométrie ${seconds(timings.geometry)}, assemblage ${seconds(timings.merge)}.`;
}
