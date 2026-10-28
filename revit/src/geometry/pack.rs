//! Mise en forme du maillage : changement de repère, soudure des sommets, sens des triangles,
//! doublons, puis assemblage dans les tableaux plats du contrat (`Output`).
//!
//! Un élément devient un [`ElementMesh`] (positions en f64, mètres, Y vers le haut, absolues) ; ce
//! calcul est indépendant d'un élément à l'autre, donc parallélisable. [`pack`] assemble ensuite
//! tous les éléments, choisit l'origine (centre de la boîte englobante de tout ce qui est dessiné)
//! et écrit les positions en f32 relatives à elle.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};

/// Pied en mètres.
pub const FOOT: f64 = 0.3048;

/// Une coque fermée a une aire vectorielle nulle (la somme des aires × normales s'annule : ce qui
/// sort d'un côté rentre de l'autre). Au-delà de cette part de l'aire totale, la forme n'est pas
/// fermée et ses matériaux sont dessinés des deux côtés. Contrairement à un décompte d'arêtes de
/// bord, la mesure ne s'inquiète pas des sommets en T entre faces voisines, que le maillage de
/// Revit laisse partout sur ses murs. Deux nappes dos à dos (vitre à deux faces) comptent comme
/// fermées : chaque côté a sa face.
pub const OPEN_RATIO: f64 = 0.02;

/// Hachage rapide (type FxHash) : les clés sont des petits entiers, SipHash serait le goulot.
#[derive(Default, Clone, Copy)]
pub struct Fx(u64);

impl Fx {
    #[inline]
    fn add(&mut self, word: u64) {
        self.0 = (self.0.rotate_left(5) ^ word).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
}

impl Hasher for Fx {
    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.add(u64::from(*byte));
        }
    }
    fn write_u8(&mut self, value: u8) {
        self.add(u64::from(value));
    }
    fn write_u16(&mut self, value: u16) {
        self.add(u64::from(value));
    }
    fn write_i16(&mut self, value: i16) {
        self.add(value as u16 as u64);
    }
    fn write_u32(&mut self, value: u32) {
        self.add(u64::from(value));
    }
    fn write_u64(&mut self, value: u64) {
        self.add(value);
    }
    fn write_i64(&mut self, value: i64) {
        self.add(value as u64);
    }
    fn write_usize(&mut self, value: usize) {
        self.add(value as u64);
    }
    fn finish(&self) -> u64 {
        self.0
    }
}

pub type FxMap<K, V> = HashMap<K, V, BuildHasherDefault<Fx>>;
pub type FxSet<K> = HashSet<K, BuildHasherDefault<Fx>>;

/// Couleur d'une face : octets sRGB et alpha (255 = opaque).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Paint {
    pub rgba: [u8; 4],
}

impl Paint {
    /// Gris neutre des faces dont Revit ne donne pas de matériau.
    pub const NEUTRAL: Paint = Paint { rgba: [190, 190, 190, 255] };

    /// Depuis des composantes sRGB 0..1 et une opacité 0..1.
    pub fn from_srgb(rgb: [f64; 3], opacity: f64) -> Self {
        let byte = |value: f64| if value.is_finite() { (value.clamp(0.0, 1.0) * 255.0).round() as u8 } else { 190 };
        let opacity = if opacity.is_finite() { opacity.clamp(0.0, 1.0) } else { 1.0 };
        let mut alpha = byte(opacity);
        // Un reste d'arrondi ne rend pas une face opaque : transparente veut dire alpha < 255.
        if opacity < 1.0 && alpha == 255 {
            alpha = 254;
        }
        Paint { rgba: [byte(rgb[0]), byte(rgb[1]), byte(rgb[2]), alpha] }
    }

    pub fn transparent(self) -> bool {
        self.rgba[3] < 255
    }
}

/// Une face à mailler, dans le repère du document Revit (pieds, Z vers le haut).
#[derive(Clone, Copy)]
pub struct Face<'a> {
    pub vertices: &'a [[f64; 3]],
    /// Normales par sommet, même repère ; `None` pour les formes reconstruites (normale du
    /// triangle).
    pub normals: Option<&'a [[f64; 3]]>,
    pub triangles: &'a [[u32; 3]],
    pub paint: Paint,
    /// Surcouche : la face se dessine par-dessus les surfaces coplanaires (le voisin d'un `GImposter`, voir
    /// `faces::select::Selected::overlay`). Elle n'est jamais groupée avec des faces ordinaires de la même couleur.
    pub overlay: bool,
}

/// Une primitive : les triangles d'un élément qui partagent une couleur (et la même priorité de dessin).
#[derive(Debug, Clone, Copy)]
pub struct Group {
    pub paint: Paint,
    /// Les triangles sont une surcouche (voir `Face::overlay`).
    pub overlay: bool,
    pub vertex_start: u32,
    pub vertex_count: u32,
    pub index_start: u32,
    pub index_count: u32,
}

/// Ce que le travail sur un élément a corrigé ou écarté.
#[derive(Debug, Clone, Copy, Default)]
pub struct MeshStats {
    /// Triangles reçus.
    pub input: usize,
    /// Triangles réduits à une arête ou un point, ou hors des sommets de leur face.
    pub degenerate: usize,
    /// Triangles identiques (mêmes sommets, même sens) à un autre du même élément.
    pub duplicates: usize,
    /// Triangles retournés parce que leur sens contredisait leurs normales.
    pub flips: usize,
    /// Coques fermées dont le volume signé était négatif (dedans-dehors), retournées en bloc.
    pub inverted: usize,
    /// Aire totale des triangles gardés, m².
    pub area: f64,
    /// Norme de l'aire vectorielle (somme des aires × normales), m² : proche de 0 pour une coque
    /// fermée.
    pub net_area: f64,
}

impl MeshStats {
    pub fn add(&mut self, other: &MeshStats) {
        self.input += other.input;
        self.degenerate += other.degenerate;
        self.duplicates += other.duplicates;
        self.flips += other.flips;
        self.inverted += other.inverted;
        self.area += other.area;
        self.net_area += other.net_area;
    }
}

/// Le maillage d'un élément, prêt à être assemblé.
#[derive(Debug, Clone, Default)]
pub struct ElementMesh {
    /// Mètres, Y vers le haut, absolus (f64 : l'origine n'est connue qu'à la fin).
    pub positions: Vec<[f64; 3]>,
    pub normals: Vec<[f32; 3]>,
    /// Locaux au premier sommet de leur groupe.
    pub indices: Vec<u32>,
    pub groups: Vec<Group>,
    /// La forme n'est pas une coque fermée : à dessiner des deux côtés.
    pub open: bool,
    pub stats: MeshStats,
    /// L'empreinte exacte de la forme que les mêmes faces auraient donnée sans surcouche (`Face::overlay`), pour une forme
    /// qui en a : la surcouche est un attribut de dessin, pas de la géométrie, mais elle sépare ses triangles dans leur propre
    /// groupe (leurs sommets ne se soudent plus à ceux des faces de la même couleur), ce qui change les tableaux sans changer les
    /// triangles. `exact_fingerprint` rend celle-ci : les essais de non-régression comparent la forme, pas la façon de la découper.
    plain_fingerprint: Option<u64>,
}

impl ElementMesh {
    pub fn triangles(&self) -> usize {
        self.indices.len() / 3
    }

    pub fn is_empty(&self) -> bool {
        self.indices.is_empty()
    }

    /// La boîte (minimum, maximum) des sommets gardés, en mètres ; `None` sans triangle.
    pub fn extent(&self) -> Option<[[f64; 3]; 2]> {
        let mut points = self.groups.iter().flat_map(|group| &self.positions[group.vertex_start as usize..(group.vertex_start + group.vertex_count) as usize]);
        let first = *points.next()?;
        Some(points.fold([first, first], |[low, high], p| [[low[0].min(p[0]), low[1].min(p[1]), low[2].min(p[2])], [high[0].max(p[0]), high[1].max(p[1]), high[2].max(p[2])]]))
    }

    /// Cette boîte tient-elle dans celle de `other`, à `tolerance` mètres près ?
    pub fn extent_within(&self, other: &ElementMesh, tolerance: f64) -> bool {
        match (self.extent(), other.extent()) {
            (Some([low, high]), Some([other_low, other_high])) => (0..3).all(|axis| low[axis] >= other_low[axis] - tolerance && high[axis] <= other_high[axis] + tolerance),
            _ => false,
        }
    }

    /// Soude, oriente et dédoublonne les faces d'un élément.
    pub fn build(faces: &[Face<'_>]) -> ElementMesh {
        let mut mesh = ElementMesh::default();
        let mut order: Vec<usize> = (0..faces.len()).collect();
        order.sort_by_key(|&index| (faces[index].paint, faces[index].overlay));

        let mut net = [0.0f64; 3];

        let mut start = 0;
        while start < order.len() {
            let (paint, overlay) = (faces[order[start]].paint, faces[order[start]].overlay);
            let mut end = start;
            while end < order.len() && faces[order[end]].paint == paint && faces[order[end]].overlay == overlay {
                end += 1;
            }
            let vertex_start = mesh.positions.len();
            let index_start = mesh.indices.len();
            let mut weld: FxMap<([i64; 3], [i16; 3]), u32> = FxMap::default();
            let mut seen: FxSet<[u32; 3]> = FxSet::default();

            for &face_index in &order[start..end] {
                let face = &faces[face_index];
                let normals = face.normals.filter(|normals| normals.len() == face.vertices.len());
                for triangle in face.triangles {
                    mesh.stats.input += 1;
                    let corners = triangle.map(|corner| corner as usize);
                    if corners.iter().any(|&corner| corner >= face.vertices.len()) {
                        mesh.stats.degenerate += 1;
                        continue;
                    }
                    let feet = corners.map(|corner| face.vertices[corner]);
                    if !feet.iter().all(|p| p.iter().all(|c| c.is_finite() && c.abs() < 1e9)) {
                        mesh.stats.degenerate += 1;
                        continue;
                    }
                    let metres = feet.map(to_frame);
                    let geometric = cross(sub(metres[1], metres[0]), sub(metres[2], metres[0]));
                    let length = norm(geometric);
                    if length < 1e-12 {
                        mesh.stats.degenerate += 1;
                        continue;
                    }
                    let flat = scale(geometric, 1.0 / length);

                    // Normales des trois coins : celles de Revit, ou à défaut celle du triangle.
                    let mut corner_normals = [flat; 3];
                    let mut from_source = false;
                    if let Some(normals) = normals {
                        from_source = true;
                        for k in 0..3 {
                            let n = to_frame_vector(normals[corners[k]]);
                            let len = norm(n);
                            if len > 1e-9 && len.is_finite() {
                                corner_normals[k] = scale(n, 1.0 / len);
                            } else {
                                from_source = false;
                            }
                        }
                    }
                    let mean = add(add(corner_normals[0], corner_normals[1]), corner_normals[2]);
                    let flip = from_source && dot(geometric, mean) < 0.0;
                    if flip {
                        mesh.stats.flips += 1;
                    }

                    let mut ids = [0u32; 3];
                    for k in 0..3 {
                        let key = (
                            quantize(feet[k]),
                            [quantize_unit(corner_normals[k][0]), quantize_unit(corner_normals[k][1]), quantize_unit(corner_normals[k][2])],
                        );
                        let next = (mesh.positions.len() - vertex_start) as u32;
                        ids[k] = *weld.entry(key).or_insert(next);
                        if ids[k] == next {
                            // Sommet neuf.
                            mesh.positions.push(metres[k]);
                            mesh.normals.push([corner_normals[k][0] as f32, corner_normals[k][1] as f32, corner_normals[k][2] as f32]);
                        }
                    }
                    if ids[0] == ids[1] || ids[1] == ids[2] || ids[0] == ids[2] {
                        mesh.stats.degenerate += 1;
                        continue;
                    }
                    let ordered = if flip { [ids[0], ids[2], ids[1]] } else { ids };
                    let canonical = if ordered[0] <= ordered[1] && ordered[0] <= ordered[2] {
                        ordered
                    } else if ordered[1] <= ordered[0] && ordered[1] <= ordered[2] {
                        [ordered[1], ordered[2], ordered[0]]
                    } else {
                        [ordered[2], ordered[0], ordered[1]]
                    };
                    if !seen.insert(canonical) {
                        mesh.stats.duplicates += 1;
                        continue;
                    }
                    mesh.indices.extend_from_slice(&ordered);

                    // Aire vectorielle, dans le sens final du triangle.
                    let sign = if flip { -0.5 } else { 0.5 };
                    net = add(net, scale(geometric, sign));
                    mesh.stats.area += length * 0.5;
                }
            }

            let vertex_count = mesh.positions.len() - vertex_start;
            let index_count = mesh.indices.len() - index_start;
            if index_count > 0 {
                mesh.groups.push(Group {
                    paint,
                    overlay,
                    vertex_start: vertex_start as u32,
                    vertex_count: vertex_count as u32,
                    index_start: index_start as u32,
                    index_count: index_count as u32,
                });
            } else {
                mesh.positions.truncate(vertex_start);
                mesh.normals.truncate(vertex_start);
            }
            start = end;
        }

        mesh.stats.net_area = norm(net);
        mesh.open = mesh.stats.area > 0.0 && mesh.stats.net_area > OPEN_RATIO * mesh.stats.area;
        if !mesh.open && mesh.signed_volume() < -1e-9 {
            // Une coque fermée dont les faces regardent vers l'intérieur : normales et sens
            // concordaient, mais dedans-dehors. On la retourne en bloc.
            mesh.invert();
            mesh.stats.inverted += 1;
        }
        if faces.iter().any(|face| face.overlay) {
            let plain: Vec<Face<'_>> = faces.iter().map(|face| Face { overlay: false, ..*face }).collect();
            mesh.plain_fingerprint = Some(ElementMesh::build(&plain).exact_fingerprint());
        }
        mesh
    }

    /// Empreinte de la forme : nombre de triangles et deux sommes de hachages de leurs sommets,
    /// arrondis au dixième de millimètre, sans égard à l'ordre ni au sens. Deux éléments ont la
    /// même empreinte quand ils dessinent exactement les mêmes triangles au même endroit.
    pub fn fingerprint(&self) -> [u64; 3] {
        let quantize = |p: [f64; 3]| [(p[0] * 1e4).round() as i64, (p[1] * 1e4).round() as i64, (p[2] * 1e4).round() as i64];
        let (mut sum, mut mixed) = (0u64, 0u64);
        for group in &self.groups {
            let start = group.vertex_start as usize;
            for corner in self.indices[group.index_start as usize..(group.index_start + group.index_count) as usize].chunks_exact(3) {
                let mut key = [0, 1, 2].map(|k| quantize(self.positions[start + corner[k] as usize]));
                key.sort();
                let mut hasher = Fx::default();
                for vertex in key {
                    for coordinate in vertex {
                        hasher.write_i64(coordinate);
                    }
                }
                let hash = hasher.finish();
                sum = sum.wrapping_add(hash);
                mixed = mixed.wrapping_add(hash.rotate_left(29).wrapping_mul(0x9e37_79b9_7f4a_7c15));
            }
        }
        [self.triangles() as u64, sum, mixed]
    }

    /// Empreinte exacte (FNV-1a sur les bits) de la forme : sommets (f64), normales, indices et couleurs de chaque
    /// groupe. Pour les essais de non-régression : deux lectures qui donnent la même empreinte donnent bit à bit la
    /// même forme, et elle ne dépend pas de l'origine du modèle (les positions sont encore absolues).
    pub fn exact_fingerprint(&self) -> u64 {
        if let Some(plain) = self.plain_fingerprint {
            return plain;
        }
        let mut hash = 0xcbf2_9ce4_8422_2325u64;
        let mut feed = |bytes: &[u8]| {
            for byte in bytes {
                hash = (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3);
            }
        };
        for group in &self.groups {
            feed(&group.paint.rgba);
            for position in &self.positions[group.vertex_start as usize..(group.vertex_start + group.vertex_count) as usize] {
                position.iter().for_each(|c| feed(&c.to_bits().to_le_bytes()));
            }
            for normal in &self.normals[group.vertex_start as usize..(group.vertex_start + group.vertex_count) as usize] {
                normal.iter().for_each(|c| feed(&c.to_bits().to_le_bytes()));
            }
            self.indices[group.index_start as usize..(group.index_start + group.index_count) as usize].iter().for_each(|i| feed(&i.to_le_bytes()));
            feed(&[0xff]);
        }
        hash
    }

    /// Volume signé (théorème de la divergence) : positif quand les triangles, antihoraires vus
    /// de l'extérieur, entourent une coque.
    fn signed_volume(&self) -> f64 {
        let Some(&anchor) = self.positions.first() else { return 0.0 };
        let mut volume = 0.0;
        for group in &self.groups {
            let start = group.vertex_start as usize;
            for corner in self.indices[group.index_start as usize..(group.index_start + group.index_count) as usize].chunks_exact(3) {
                let [a, b, c] = [corner[0], corner[1], corner[2]].map(|index| sub(self.positions[start + index as usize], anchor));
                volume += dot(a, cross(b, c)) / 6.0;
            }
        }
        volume
    }

    fn invert(&mut self) {
        for triangle in self.indices.chunks_exact_mut(3) {
            triangle.swap(1, 2);
        }
        for normal in &mut self.normals {
            *normal = [-normal[0], -normal[1], -normal[2]];
        }
    }
}

/// Repère du document (pieds, Z haut) vers le repère de la scène (mètres, Y haut) :
/// `(x, y, z) → (x, z, −y)`. C'est une rotation (déterminant +1), le sens des triangles est donc
/// conservé.
#[inline]
pub fn to_frame(p: [f64; 3]) -> [f64; 3] {
    [p[0] * FOOT, p[2] * FOOT, -p[1] * FOOT]
}

#[inline]
fn to_frame_vector(v: [f64; 3]) -> [f64; 3] {
    [v[0], v[2], -v[1]]
}

#[inline]
fn quantize(p: [f64; 3]) -> [i64; 3] {
    // Dixième de millième de pied : assez fin pour ne rien fondre qui compte, assez large pour
    // recoller des sommets recalculés par deux faces voisines.
    [(p[0] * 1e5).round() as i64, (p[1] * 1e5).round() as i64, (p[2] * 1e5).round() as i64]
}

#[inline]
fn quantize_unit(value: f64) -> i16 {
    (value * 1000.0).round() as i16
}

#[inline]
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
fn scale(a: [f64; 3], s: f64) -> [f64; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}
#[inline]
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
#[inline]
fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

/// Les tableaux plats du contrat `Output`.
#[derive(Debug, Clone, Default)]
pub struct Packed {
    pub origin: [f64; 3],
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    pub primitives: Vec<u32>,
    pub materials: Vec<u8>,
    pub double_sided_elements: usize,
}

/// L'origine du modèle : le centre de la boîte englobante de tout ce qui est dessiné (`[0, 0, 0]` sans sommet).
pub fn origin_of<'a>(meshes: impl Iterator<Item = &'a ElementMesh>) -> [f64; 3] {
    let mut low = [f64::INFINITY; 3];
    let mut high = [f64::NEG_INFINITY; 3];
    let mut any = false;
    for mesh in meshes {
        for p in &mesh.positions {
            any = true;
            for axis in 0..3 {
                low[axis] = low[axis].min(p[axis]);
                high[axis] = high[axis].max(p[axis]);
            }
        }
    }
    if any { [(low[0] + high[0]) / 2.0, (low[1] + high[1]) / 2.0, (low[2] + high[2]) / 2.0] } else { [0.0; 3] }
}

/// Octets d'une ligne de la table des matériaux : r, g, b, a (sRGB), transparent (0 ou 1), double face (0 ou 1), surcouche (0 ou 1).
pub const MATERIAL_STRIDE: usize = 7;

/// La table des matériaux du contrat, dans l'ordre de première apparition : partagée entre les morceaux d'une même
/// lecture, pour que l'indice d'un matériau soit le même dans tous (chaque morceau emporte la table telle qu'elle est à
/// sa fin, dont la table finale est le prolongement).
#[derive(Debug, Clone, Default)]
pub struct MaterialTable(BTreeMap<[u8; MATERIAL_STRIDE], u32>);

impl MaterialTable {
    fn index(&mut self, row: [u8; MATERIAL_STRIDE]) -> u32 {
        let next = self.0.len() as u32;
        *self.0.entry(row).or_insert(next)
    }

    /// Les lignes de la table, [`MATERIAL_STRIDE`] octets chacune, dans l'ordre des indices.
    pub fn rows(&self) -> Vec<u8> {
        let mut rows: Vec<([u8; MATERIAL_STRIDE], u32)> = self.0.iter().map(|(row, index)| (*row, *index)).collect();
        rows.sort_by_key(|(_, index)| *index);
        rows.into_iter().flat_map(|(row, _)| row).collect()
    }
}

/// Assemble les éléments (dans l'ordre : l'indice d'élément des primitives est la position dans
/// `meshes`) et libère chaque maillage dès qu'il est copié.
pub fn pack(meshes: Vec<ElementMesh>) -> Packed {
    let origin = origin_of(meshes.iter());
    pack_chunk(meshes, origin, &mut MaterialTable::default())
}

/// Assemble un morceau : les éléments `meshes`, dans l'ordre, avec des positions relatives à `origin` (celle du
/// modèle entier, ou propre au morceau), et les matériaux dans `table`. Les indices d'élément des primitives sont ceux
/// du morceau (de 0) ; `materials` est la table entière jusqu'ici. Assembler tout le modèle en un seul morceau
/// (`pack`) ou en plusieurs mis bout à bout (`lib::read_from`) donne exactement les mêmes tableaux.
pub fn pack_chunk(meshes: Vec<ElementMesh>, origin: [f64; 3], table: &mut MaterialTable) -> Packed {
    let vertices: usize = meshes.iter().map(|mesh| mesh.positions.len()).sum();
    let indices: usize = meshes.iter().map(|mesh| mesh.indices.len()).sum();

    let mut packed = Packed { origin, ..Packed::default() };
    packed.positions.reserve_exact(vertices * 3);
    packed.normals.reserve_exact(vertices * 3);
    packed.indices.reserve_exact(indices);

    for (element, mesh) in meshes.into_iter().enumerate() {
        let vertex_base = (packed.positions.len() / 3) as u32;
        let index_base = packed.indices.len() as u32;
        if mesh.open {
            packed.double_sided_elements += 1;
        }
        for group in &mesh.groups {
            let row = [group.paint.rgba[0], group.paint.rgba[1], group.paint.rgba[2], group.paint.rgba[3], u8::from(group.paint.transparent()), u8::from(mesh.open), u8::from(group.overlay)];
            let material = table.index(row);
            packed.primitives.extend_from_slice(&[
                element as u32,
                vertex_base + group.vertex_start,
                group.vertex_count,
                index_base + group.index_start,
                group.index_count,
                material,
            ]);
        }
        for p in &mesh.positions {
            for axis in 0..3 {
                packed.positions.push((p[axis] - origin[axis]) as f32);
            }
        }
        for n in &mesh.normals {
            packed.normals.extend_from_slice(n);
        }
        packed.indices.extend_from_slice(&mesh.indices);
    }
    packed.materials = table.rows();
    packed
}

#[cfg(test)]
mod tests {
    use super::*;

    const GREY: Paint = Paint::NEUTRAL;

    fn face<'a>(vertices: &'a [[f64; 3]], normals: Option<&'a [[f64; 3]]>, triangles: &'a [[u32; 3]]) -> Face<'a> {
        Face { vertices, normals, triangles, paint: GREY, overlay: false }
    }

    /// Normale géométrique du premier triangle d'un maillage (sens des indices).
    fn geometric(mesh: &ElementMesh) -> [f64; 3] {
        let [a, b, c] = [mesh.indices[0], mesh.indices[1], mesh.indices[2]].map(|i| mesh.positions[i as usize]);
        cross(sub(b, a), sub(c, a))
    }

    #[test]
    fn le_changement_de_repere_est_une_rotation() {
        let moved = to_frame([1.0, 2.0, 3.0]);
        for (value, expected) in moved.iter().zip([0.3048, 0.9144, -0.6096]) {
            assert!((value - expected).abs() < 1e-12);
        }
        // Le haut (Z) devient Y ; le déterminant de (x, y, z) → (x, z, −y) est +1.
        let (x, y, z) = (to_frame([1.0, 0.0, 0.0]), to_frame([0.0, 1.0, 0.0]), to_frame([0.0, 0.0, 1.0]));
        let determinant = dot(x, cross(y, z)) / FOOT.powi(3);
        assert!((determinant - 1.0).abs() < 1e-12);
    }

    #[test]
    fn un_triangle_vers_le_haut_reste_antihoraire_vu_de_dessus() {
        // Triangle horizontal, antihoraire vu de +Z, normale +Z : après le changement de repère il
        // est antihoraire vu de +Y, normale +Y.
        let vertices = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let normals = [[0.0, 0.0, 1.0]; 3];
        let mesh = ElementMesh::build(&[face(&vertices, Some(&normals), &[[0, 1, 2]])]);
        assert_eq!(mesh.stats.flips, 0);
        assert!(geometric(&mesh)[1] > 0.0);
        assert!(mesh.normals.iter().all(|n| (n[1] - 1.0).abs() < 1e-6));
    }

    #[test]
    fn un_triangle_contraire_a_ses_normales_est_retourne() {
        let vertices = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let normals = [[0.0, 0.0, -1.0]; 3];
        let mesh = ElementMesh::build(&[face(&vertices, Some(&normals), &[[0, 1, 2]])]);
        assert_eq!(mesh.stats.flips, 1);
        // Les normales de Revit font foi : le triangle regarde vers −Y.
        assert!(geometric(&mesh)[1] < 0.0);
    }

    #[test]
    fn l_empreinte_ne_depend_ni_de_l_ordre_ni_du_sens_mais_du_lieu() {
        let vertices = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 1.0, 0.0]];
        let one = ElementMesh::build(&[face(&vertices, None, &[[0, 1, 2], [1, 3, 2]])]);
        let other = ElementMesh::build(&[face(&vertices, None, &[[2, 3, 1], [2, 1, 0]])]);
        assert_eq!(one.fingerprint(), other.fingerprint());
        let moved: Vec<[f64; 3]> = vertices.iter().map(|v| [v[0] + 10.0, v[1], v[2]]).collect();
        assert_ne!(one.fingerprint(), ElementMesh::build(&[face(&moved, None, &[[0, 1, 2], [1, 3, 2]])]).fingerprint());
    }

    #[test]
    fn une_coque_fermee_a_l_envers_est_retournee() {
        let vertices = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0]];
        let cube = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
        let outside = ElementMesh::build(&[face(&vertices, None, &cube)]);
        assert!(outside.signed_volume() > 0.0 && outside.stats.inverted == 0);
        // Même cube, tous les triangles à l'envers (sans normales de Revit pour les contredire).
        let reversed: Vec<[u32; 3]> = cube.iter().map(|t| [t[0], t[2], t[1]]).collect();
        let inside = ElementMesh::build(&[face(&vertices, None, &reversed)]);
        assert_eq!(inside.stats.inverted, 1);
        assert!(inside.signed_volume() > 0.0);
    }

    #[test]
    fn les_doublons_et_les_triangles_plats_sont_ecartes() {
        let vertices = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [2.0, 0.0, 0.0]];
        // Deux fois le même triangle (l'un tourné d'un cran), un triangle aligné.
        let triangles = [[0, 1, 2], [1, 2, 0], [0, 1, 3]];
        let mesh = ElementMesh::build(&[face(&vertices, None, &triangles)]);
        assert_eq!(mesh.triangles(), 1);
        assert_eq!(mesh.stats.duplicates, 1);
        assert_eq!(mesh.stats.degenerate, 1);
    }

    #[test]
    fn un_cube_est_ferme_et_une_nappe_est_ouverte() {
        let cube_vertices = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0]];
        let cube = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
        assert!(!ElementMesh::build(&[face(&cube_vertices, None, &cube)]).open);
        let sheet = ElementMesh::build(&[face(&cube_vertices, None, &cube[..2])]);
        assert!(sheet.open);
    }

    #[test]
    fn l_assemblage_ecrit_les_tableaux_du_contrat() {
        let vertices = [[10.0, 0.0, 0.0], [11.0, 0.0, 0.0], [10.0, 1.0, 0.0]];
        let glass = Paint::from_srgb([0.1, 0.2, 0.3], 0.4);
        let one = ElementMesh::build(&[face(&vertices, None, &[[0, 1, 2]])]);
        let two = ElementMesh::build(&[Face { vertices: &vertices, normals: None, triangles: &[[0, 1, 2]], paint: glass, overlay: false }]);
        let packed = pack(vec![one, two]);
        assert_eq!(packed.primitives.len(), 12);
        assert_eq!(packed.primitives[0..6], [0, 0, 3, 0, 3, 0]);
        assert_eq!(packed.primitives[6..12], [1, 3, 3, 3, 3, 1]);
        // Deux matériaux : le gris opaque et le verre transparent, sept octets chacun (le dernier : la surcouche).
        assert_eq!(packed.materials.len(), 2 * MATERIAL_STRIDE);
        assert_eq!(&packed.materials[0..7], &[190, 190, 190, 255, 0, 1, 0]);
        assert_eq!(&packed.materials[7..14], &[26, 51, 77, 102, 1, 1, 0]);
        // L'origine est le centre de la boîte englobante ; les positions en sont relatives.
        let (min, max) = (to_frame([10.0, 0.0, 0.0]), to_frame([11.0, 1.0, 0.0]));
        assert!((packed.origin[0] - (min[0] + max[0]) / 2.0).abs() < 1e-12);
        assert!(packed.positions.iter().all(|value| value.abs() < 0.2));
    }

    /// Les faces de surcouche ont leur propre primitive et leur propre matériau, même de la couleur d'une face ordinaire : le
    /// viewer ne fusionne que ce qui se dessine pareil, et la surcouche, elle, gagne contre une face coplanaire.
    #[test]
    fn une_surcouche_n_est_jamais_groupee_avec_une_face_ordinaire_de_la_meme_couleur() {
        let vertices = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let ordinary = Face { vertices: &vertices, normals: None, triangles: &[[0, 1, 2]], paint: GREY, overlay: false };
        let over = Face { vertices: &vertices, normals: None, triangles: &[[0, 2, 1]], paint: GREY, overlay: true };
        let mesh = ElementMesh::build(&[over, ordinary]);
        assert_eq!(mesh.groups.len(), 2);
        assert_eq!(mesh.groups.iter().filter(|group| group.overlay).count(), 1);
        let packed = pack(vec![mesh]);
        // Deux lignes de matériau qui ne diffèrent que par le dernier octet.
        assert_eq!(packed.materials.len(), 2 * MATERIAL_STRIDE);
        assert_eq!(&packed.materials[0..6], &packed.materials[7..13]);
        assert_eq!(packed.materials[6] + packed.materials[13], 1);
        // Les groupes sont triés par couleur puis par surcouche : la face ordinaire d'abord, la surcouche ensuite, chacune avec
        // la ligne de sa nature.
        let natures: Vec<u8> = packed.primitives.chunks_exact(6).map(|primitive| packed.materials[primitive[5] as usize * MATERIAL_STRIDE + 6]).collect();
        assert_eq!(natures, vec![0, 1]);
    }

    /// La surcouche est un attribut de dessin : l'empreinte exacte d'une forme (celle des essais de non-régression) est celle
    /// des mêmes faces sans elle, même quand la surcouche sépare leurs triangles d'une face de la même couleur (leurs sommets
    /// ne se soudent plus : les tableaux changent, pas les triangles).
    #[test]
    fn l_empreinte_exacte_ignore_la_surcouche() {
        let vertices = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 1.0, 0.0]];
        let plain = ElementMesh::build(&[face(&vertices, None, &[[0, 1, 2]]), face(&vertices, None, &[[1, 3, 2]])]);
        let over = ElementMesh::build(&[face(&vertices, None, &[[0, 1, 2]]), Face { vertices: &vertices, normals: None, triangles: &[[1, 3, 2]], paint: GREY, overlay: true }]);
        assert_eq!(plain.groups.len(), 1);
        assert_eq!(over.groups.len(), 2);
        assert_eq!(plain.exact_fingerprint(), over.exact_fingerprint());
        assert_eq!(plain.fingerprint(), over.fingerprint());
        // Sans surcouche, rien n'est gardé à part : l'empreinte vient des groupes.
        assert!(plain.plain_fingerprint.is_none());
    }
}
