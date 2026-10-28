/* tslint:disable */
/* eslint-disable */

/** Ce que `readRevit` rend : un objet simple, tableaux typés compris (voir docs/lecture-revit.md). */
export interface RevitOutput {
    /** Clé d'identité de chaque élément : GlobalId IFC de Revit, à défaut `rvt-<ElementId>`. */
    keys: string[];
    /** Nom affiché de chaque élément : le libellé de sa fiche (« Famille : Type »), le même que `label` dans `metadata`. */
    names: string[];
    /** 0 forme Revit, 1 partielle, 2 reconstruite, 3 inconnue (boîte englobante). */
    sources: Uint8Array;
    /** Centre du modèle en mètres, Y vers le haut : les positions en sont relatives. */
    origin: [number, number, number];
    positions: Float32Array;
    normals: Float32Array;
    /** Coins des triangles, locaux au premier sommet de la primitive. */
    indices: Uint32Array;
    /** Pas de 6 : élément, premier sommet, nombre de sommets, premier indice, nombre d'indices, matériau. */
    primitives: Uint32Array;
    /**
     * Pas de 7 : r, g, b, a (octets sRGB), transparent (0/1), double face (0/1), surcouche (0/1 : triangles que le
     * viewer dessine par-dessus les surfaces coplanaires, l'image d'un contenu RPC posée sur le sol).
     */
    materials: Uint8Array;
    /** JSON du contrat docs/contrat-metadonnees.md (version 1). Vide quand la sortie est partie par morceaux. */
    metadata: string;
    /**
     * Quand la sortie est partie par morceaux (`readRevitFile` avec `onChunk`) : le JSON de métadonnées est
     * `metadataHead` + les `metadataElements` des morceaux séparés par des virgules + `metadataTail`.
     */
    metadataHead?: string;
    metadataTail?: string;
    report: {
        release: number | null;
        experimental: boolean;
        elements: number;
        triangles: number;
        seconds: number;
        sources: { revit: number; partial: number; rebuilt: number; unknown: number };
        withoutGeometry: number;
        warnings: string[];
        /** Durée de chaque étape de la lecture, dans l'ordre (diagnostic). */
        stages: { name: string; seconds: number }[];
    };
}

/**
 * Un morceau de la sortie (`readRevitFile` avec `onChunk`) : quelques éléments consécutifs, dans l'ordre des clés,
 * avec leurs tableaux (les mêmes que ceux de `RevitOutput`, restreints à ces éléments). Les indices d'élément des
 * primitives sont ceux du morceau (de 0) ; `materials` est la table de toute la lecture jusqu'à ce morceau (celle du
 * morceau suivant la prolonge) ; `origin` est l'origine du modèle entier. Mis bout à bout, les morceaux redonnent
 * exactement la sortie d'un bloc.
 */
export interface RevitChunk {
    keys: string[];
    names: string[];
    sources: Uint8Array;
    origin: [number, number, number];
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    primitives: Uint32Array;
    materials: Uint8Array;
    /** Les fragments `"clé":{…}` du JSON de métadonnées de ces éléments, séparés par des virgules. */
    metadataElements: string;
}



/**
 * Lit un fichier Revit et rend un `RevitOutput`. Réglages (`options`, objet JavaScript facultatif) :
 * `prudent` (booléen) lit les formes avec rvt-rs seul, sans aucun de nos maillages de faces : une face
 * que rvt-rs refuse reste manquante (forme partielle ou boîte englobante). C'est le recours après une
 * « panique interne » : une panique ne se rattrape pas en WebAssembly, l'appelant recommence dans un
 * worker neuf avec `{ prudent: true }`. `triangleBudget` (nombre) est le budget de triangles du fichier entier,
 * que le viewer règle d'après la mémoire de l'appareil (`readRevit.ts`) : au-delà, les éléments lus ensuite sont
 * montrés par leur boîte et marqués « Inconnue » (3 millions à défaut). Les autres propriétés sont ignorées.
 */
export function readRevit(bytes: Uint8Array, options?: object | null): RevitOutput;

/**
 * Lit un fichier Revit **sans le copier dans la mémoire du module** : `size` est sa taille en octets et `read(début,
 * longueur)` une fonction JavaScript qui rend un `Uint8Array` de ces octets (dans un worker : `FileReaderSync` sur
 * `file.slice(début, début + longueur)`). Le lecteur demande des fenêtres de `WINDOW_BYTES` ; les petits flux du
 * conteneur sont recopiés dans un mini conteneur, les partitions se lisent par tranches (voir `native::document`).
 * Mêmes réglages et même résultat que `readRevit`.
 * Avec `onChunk` (fonction JavaScript), la sortie part par morceaux (`RevitChunk`) pendant le maillage, dans l'ordre
 * où les formes s'achèvent : la mémoire du module ne tient jamais tous les maillages à la fois. Le `RevitOutput` rendu
 * n'a alors que `report`, `names` (les libellés des fiches, un par élément dans l'ordre des morceaux, qui remplacent
 * leurs noms provisoires) et `metadata` (le JSON entier) ; ses tableaux et ses clés sont vides.
 */
export function readRevitFile(size: number, read: Function, options?: object | null, on_chunk?: Function | null): RevitOutput;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly readRevit: (a: number, b: number, c: number) => [number, number, number];
    readonly readRevitFile: (a: number, b: any, c: number, d: number) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
