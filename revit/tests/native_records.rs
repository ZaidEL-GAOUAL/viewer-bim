//! L'extraction native des enregistrements (`revit::native`) : l'encadrement d'un groupe sur des
//! octets fabriqués (règles de 2016–2017, de 2019–2023 et de 2024, désaccords, entrées malformées),
//! `normalize_legacy`, puis sur de vrais fichiers quand `revit/samples/` existe
//! (scripts/fetch-revit-samples.mjs) :
//! - sur chaque fichier de 2023 et plus, le portage rend exactement les mêmes enregistrements, les
//!   mêmes graphes (empreinte de chacun) et le même bilan que rvt-rs ;
//! - sur chaque fichier de 2015 à 2022, les taux de décodage de la note de recherche (99,4 % au moins
//!   du canal 102, 100 % du 103), aucune erreur d'encadrement, l'encadrement attendu de l'année ;
//! - sur les fichiers de 2012 à 2014, les taux mesurés par année (canal 102 : 99,3 % en 2012, 99,4 % en 2013, 99,0 % en 2014 ;
//!   canal 103 : 100 %), l'encadrement de 2015 à 2017 (identifiant de 4 octets, taille déclarée plus 4 par enregistrement).
//!
//! À lancer avec `cargo test --release --test native_records` : en débogage, le décodage est long.

use std::collections::{BTreeMap, BTreeSet};
use std::hash::Hasher;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Instant;

use revit::native::{self, DeclaredSize, Options, Record, Summary};
use rvt::research::native_document;
use rvt::research::native_index::Identity;
use rvt::research::native_parameters::ObjectGraph;
use rvt::research::native_segments::GroupSource;
use serde::Serialize;

fn sample_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(name)
}

/// Les octets d'un fichier d'essai, ou `None` (essai ignoré) s'il n'a pas été téléchargé.
fn sample_bytes(relative: &str) -> Option<Vec<u8>> {
    let path = sample_path(relative);
    if !path.exists() {
        eprintln!("{relative} absent : essai ignoré (npm run samples:revit)");
        return None;
    }
    Some(std::fs::read(&path).unwrap_or_else(|error| panic!("{relative} illisible : {error}")))
}

// ---------------------------------------------------------------------------------------------
// Groupes fabriqués
// ---------------------------------------------------------------------------------------------

fn record_bytes(id: u64, id_bytes: usize, channel: u64, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&id.to_le_bytes()[..id_bytes]);
    if channel != 101 {
        out.extend_from_slice(&0xa5a5_caf3_u32.to_le_bytes()); // l'« empreinte » que Revit 2016 et 2017 écrivent
    }
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out
}

fn bodies() -> Vec<(u64, Vec<u8>)> {
    vec![(100, vec![1, 2, 3, 4, 5]), (101, vec![]), (7_000_000, vec![9; 40]), (102, vec![0xab; 3]), (5, vec![7; 1])]
}

fn group_bytes(records: &[(u64, Vec<u8>)], id_bytes: usize, channel: u64) -> Vec<u8> {
    records.iter().flat_map(|(id, body)| record_bytes(*id, id_bytes, channel, body)).collect()
}

fn source(channel: u64, objects: u64, body_bytes: u64) -> GroupSource {
    GroupSource { content_key: None, content_element_count: None, channel, first_marker_offset: 0, segment_count: 1, declared_objects: objects, declared_body_bytes: body_bytes }
}

fn body_sum(records: &[(u64, Vec<u8>)]) -> u64 {
    records.iter().map(|(_, body)| body.len() as u64).sum()
}

#[test]
fn identifiant_selon_l_annee() {
    assert_eq!(native::id_width(2015), 4);
    assert_eq!(native::id_width(2022), 4);
    assert_eq!(native::id_width(2023), 4);
    assert_eq!(native::id_width(2024), 8);
    assert_eq!(native::id_width(2027), 8);
}

#[test]
fn lit_la_regle_de_2018_a_2023() {
    let records = bodies();
    for version in [2018, 2019, 2020, 2021, 2022, 2023] {
        let bytes = group_bytes(&records, 4, 102);
        let grouping = native::group_records(&source(102, 5, body_sum(&records)), &bytes, version).expect("groupe cohérent");
        assert_eq!(grouping.id_bytes, 4, "{version}");
        assert_eq!(grouping.rule, DeclaredSize::Body, "{version}");
        assert!(!grouping.unexpected, "{version}");
        let ids: Vec<u64> = grouping.frames.iter().map(|frame| frame.id).collect();
        assert_eq!(ids, vec![100, 101, 7_000_000, 102, 5]);
        // Les positions : en-tête de 12 octets (id 4, empreinte 4, longueur 4), corps, longueur répétée.
        let first = grouping.frames[0];
        assert_eq!((first.offset, first.start, first.end), (0, 12, 17));
        let second = grouping.frames[1];
        assert_eq!((second.offset, second.start, second.end), (21, 33, 33));
        let last = grouping.frames[4];
        assert_eq!(last.end, bytes.len() - 4);
    }
}

#[test]
fn lit_la_regle_de_2016_et_2017() {
    let records = bodies();
    for version in [2015, 2016, 2017] {
        let bytes = group_bytes(&records, 4, 102);
        let declared = body_sum(&records) + 4 * records.len() as u64;
        let grouping = native::group_records(&source(102, 5, declared), &bytes, version).expect("groupe cohérent");
        assert_eq!(grouping.id_bytes, 4);
        assert_eq!(grouping.rule, DeclaredSize::BodyAndTrailer, "{version}");
        assert!(!grouping.unexpected, "{version}");
        assert_eq!(grouping.frames.len(), 5);
    }
}

#[test]
fn lit_la_regle_de_2024_a_2027() {
    let records = bodies();
    for version in [2024, 2025, 2026, 2027] {
        let bytes = group_bytes(&records, 8, 103);
        let grouping = native::group_records(&source(103, 5, body_sum(&records)), &bytes, version).expect("groupe cohérent");
        assert_eq!(grouping.id_bytes, 8, "{version}");
        assert_eq!(grouping.rule, DeclaredSize::Body);
        assert!(!grouping.unexpected);
        assert_eq!(grouping.frames[2].id, 7_000_000);
        // En 2024+, l'en-tête fait 16 octets.
        assert_eq!(grouping.frames[0].start, 16);
    }
}

#[test]
fn le_canal_101_a_un_en_tete_plus_court() {
    let records = bodies();
    let bytes = group_bytes(&records, 4, 101);
    let grouping = native::group_records(&source(101, 5, body_sum(&records)), &bytes, 2019).expect("groupe cohérent");
    assert_eq!(grouping.frames[0].start, 8);
    assert_eq!(grouping.frames.len(), 5);
}

#[test]
fn l_annee_2018_suit_la_regle_de_2019() {
    // Mesuré sur le modèle de projet de Revit 2018 (Rhino.Inside.Revit) : la somme des corps, sans les
    // longueurs répétées, comme de 2019 à 2026.
    let records = bodies();
    let bytes = group_bytes(&records, 4, 102);
    let plain = native::group_records(&source(102, 5, body_sum(&records)), &bytes, 2018).expect("règle de la somme");
    assert_eq!(plain.rule, DeclaredSize::Body);
    assert!(!plain.unexpected);
    let counted = native::group_records(&source(102, 5, body_sum(&records) + 20), &bytes, 2018).expect("règle de la somme plus 4 par enregistrement");
    assert_eq!(counted.rule, DeclaredSize::BodyAndTrailer);
    assert!(counted.unexpected);
}

#[test]
fn signale_l_ecart_avec_l_attendu_de_l_annee() {
    let records = bodies();
    // Un groupe de 2019 qui suit la règle de 2017 : lu, mais signalé.
    let bytes = group_bytes(&records, 4, 102);
    let grouping = native::group_records(&source(102, 5, body_sum(&records) + 20), &bytes, 2019).expect("lu");
    assert_eq!(grouping.rule, DeclaredSize::BodyAndTrailer);
    assert!(grouping.unexpected);
    // Un groupe de 2017 qui suit la règle de 2019.
    let grouping = native::group_records(&source(102, 5, body_sum(&records)), &bytes, 2017).expect("lu");
    assert_eq!(grouping.rule, DeclaredSize::Body);
    assert!(grouping.unexpected);
    // Un groupe d'identifiants de 4 octets dans un fichier de 2024 : la largeur est tirée des octets.
    let grouping = native::group_records(&source(102, 5, body_sum(&records)), &bytes, 2024).expect("lu");
    assert_eq!(grouping.id_bytes, 4);
    assert!(grouping.unexpected);
    // L'inverse.
    let wide = group_bytes(&records, 8, 102);
    let grouping = native::group_records(&source(102, 5, body_sum(&records)), &wide, 2019).expect("lu");
    assert_eq!(grouping.id_bytes, 8);
    assert!(grouping.unexpected);
    assert_eq!(grouping.frames[2].id, 7_000_000);
}

#[test]
fn un_groupe_vide_est_lu() {
    let grouping = native::group_records(&source(102, 0, 0), &[], 2020).expect("groupe vide");
    assert!(grouping.frames.is_empty());
    assert!(!grouping.unexpected);
}

/// Message d'erreur complet d'un groupe refusé.
fn refusal(source: &GroupSource, bytes: &[u8], version: u32) -> String {
    match native::group_records(source, bytes, version) {
        Ok(grouping) => panic!("groupe accepté à tort : {grouping:?}"),
        Err(error) => format!("{error:#}"),
    }
}

#[test]
fn refuse_une_taille_declaree_qui_ne_convient_a_aucune_regle() {
    let records = bodies();
    let bytes = group_bytes(&records, 4, 102);
    let sum = body_sum(&records);
    for declared in [sum + 1, sum + 19, sum + 21, sum.saturating_sub(1), 0, u64::MAX] {
        let message = refusal(&source(102, 5, declared), &bytes, 2019);
        assert!(message.contains("canal 102") && message.contains("Revit 2019"), "{message}");
        assert!(message.contains("ni la somme"), "{message}");
    }
}

#[test]
fn refuse_un_nombre_d_objets_different() {
    let records = bodies();
    let bytes = group_bytes(&records, 4, 102);
    for declared in [4, 6, 0, u64::MAX] {
        let message = refusal(&source(102, declared, body_sum(&records)), &bytes, 2019);
        assert!(message.contains("déclarés") || message.contains("plus d'enregistrements"), "{message}");
    }
}

#[test]
fn refuse_un_groupe_tronque() {
    let records = bodies();
    let bytes = group_bytes(&records, 4, 102);
    let declared = body_sum(&records);
    // Chaque coupe, sauf aux frontières d'enregistrement, tronque un en-tête ou un corps ; aux
    // frontières, c'est le nombre d'objets qui ne suit plus.
    for cut in 0..bytes.len() {
        let message = refusal(&source(102, 5, declared), &bytes[..cut], 2019);
        assert!(!message.is_empty());
    }
    assert!(refusal(&source(102, 5, declared), &bytes[..bytes.len() - 1], 2019).contains("tronqué"));
}

#[test]
fn refuse_des_longueurs_discordantes() {
    let records = bodies();
    let mut bytes = group_bytes(&records, 4, 102);
    // La longueur répétée du premier enregistrement (corps de 5 octets) : octets 17..21.
    bytes[17] = 6;
    let message = refusal(&source(102, 5, body_sum(&records)), &bytes, 2019);
    assert!(message.contains("discordantes"), "{message}");
}

#[test]
fn une_longueur_demesuree_ne_deborde_pas() {
    // Une longueur de 4 294 967 295 octets : sur 32 bits, `début + longueur` déborderait un `usize`.
    for id_bytes in [4, 8] {
        let mut bytes = group_bytes(&bodies(), id_bytes, 102);
        let length_at = id_bytes + 4;
        bytes[length_at..length_at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        let message = refusal(&source(102, 5, u64::from(u32::MAX)), &bytes, 2019);
        assert!(message.contains("tronqué") || message.contains("discordantes"), "{message}");
        // Même chose en toute fin de groupe, là où l'addition passe le plus près du bord.
        let mut tail = record_bytes(1, id_bytes, 102, &[1, 2, 3]);
        let at = tail.len() - 4;
        tail[at..].copy_from_slice(&u32::MAX.to_le_bytes());
        let at = id_bytes + 4;
        tail[at..at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        refusal(&source(102, 1, u64::from(u32::MAX)), &tail, 2024);
    }
}

#[test]
fn des_tailles_declarees_demesurees_n_allouent_rien() {
    // Un groupe de 100 000 enregistrements vides qui prétend en contenir u64::MAX : refusé sans que
    // rien ne soit réservé d'après la déclaration, et un groupe qui en déclare moins que lus l'est
    // dès le premier de trop.
    let records: Vec<(u64, Vec<u8>)> = (0..100_000u64).map(|id| (id, Vec::new())).collect();
    let bytes = group_bytes(&records, 4, 102);
    refusal(&source(102, u64::MAX, u64::MAX), &bytes, 2020);
    let message = refusal(&source(102, 3, 0), &bytes, 2020);
    assert!(message.contains("plus d'enregistrements"), "{message}");
    // Et le groupe cohérent passe.
    native::group_records(&source(102, 100_000, 0), &bytes, 2020).expect("100 000 enregistrements");
}

#[test]
fn refuse_un_canal_inconnu() {
    let records = bodies();
    let bytes = group_bytes(&records, 4, 102);
    for channel in [0, 100, 104, u64::MAX] {
        let message = refusal(&source(channel, 5, body_sum(&records)), &bytes, 2020);
        assert!(message.contains("canal"), "{message}");
    }
}

/// Les propriétés qu'un groupe accepté doit avoir, quel que soit l'octet qu'on a abîmé.
fn check_invariants(bytes: &[u8], grouping: &native::Grouping) {
    let mut previous_end = 0;
    for frame in &grouping.frames {
        assert!(frame.offset >= previous_end);
        assert!(frame.offset < frame.start && frame.start <= frame.end && frame.end + 4 <= bytes.len(), "{frame:?} sur {}", bytes.len());
        previous_end = frame.end + 4;
    }
    assert!(previous_end <= bytes.len());
}

#[test]
fn des_octets_abimes_ne_font_jamais_paniquer() {
    let records = bodies();
    let sum = body_sum(&records);
    for (id_bytes, channel, version, declared) in [(4, 102, 2017, sum + 20), (4, 103, 2019, sum), (8, 102, 2024, sum), (4, 101, 2020, sum)] {
        let clean = group_bytes(&records, id_bytes, channel);
        for position in 0..clean.len() {
            for damage in [0x00u8, 0xff, 0x80, 0x01] {
                let mut bytes = clean.clone();
                bytes[position] = damage;
                if let Ok(grouping) = native::group_records(&source(channel, 5, declared), &bytes, version) {
                    check_invariants(&bytes, &grouping);
                }
            }
            if let Ok(grouping) = native::group_records(&source(channel, 5, declared), &clean[..position], version) {
                check_invariants(&clean[..position], &grouping);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// normalize_legacy
// ---------------------------------------------------------------------------------------------

fn graph(objects: serde_json::Value) -> ObjectGraph {
    serde_json::from_value(serde_json::json!({ "consumed_bytes": 0, "objects": objects, "edges": [] })).expect("graphe d'essai")
}

fn object(class: &str, fields: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "class_tag": 12, "class_name": class, "token": 1, "start": 0, "fields_end": 0, "fields": fields })
}

#[test]
fn normalize_legacy_ajoute_m_grepid_absent() {
    let mut graph = graph(serde_json::json!([
        object("GElement", serde_json::json!({ "m_GInfo": {} })),
        object("InstanceInfo", serde_json::json!({ "m_Trf": { "m_origin": [1, 2, 3] }, "m_symbolId": { "m_id": { "m_id": 7 } } })),
        object("InstanceInfo", serde_json::json!({ "m_Trf": {} })),
    ]));
    assert_eq!(native::normalize_legacy(&mut graph), 2);
    assert_eq!(graph.objects[1].fields["m_GRepId"], serde_json::json!(0));
    assert_eq!(graph.objects[2].fields["m_GRepId"], serde_json::json!(0));
    // Les autres champs et les autres classes ne bougent pas.
    assert_eq!(graph.objects[1].fields["m_Trf"]["m_origin"], serde_json::json!([1, 2, 3]));
    assert_eq!(graph.objects[1].fields["m_symbolId"]["m_id"]["m_id"], serde_json::json!(7));
    assert!(graph.objects[0].fields.get("m_GRepId").is_none());
    // Idempotent.
    assert_eq!(native::normalize_legacy(&mut graph), 0);
}

#[test]
fn normalize_legacy_ne_touche_pas_un_champ_present() {
    let mut graph = graph(serde_json::json!([
        object("InstanceInfo", serde_json::json!({ "m_GRepId": 0 })),
        object("InstanceInfo", serde_json::json!({ "m_GRepId": 5 })),
        object("InstanceInfo", serde_json::json!({ "m_GRepId": null })),
    ]));
    assert_eq!(native::normalize_legacy(&mut graph), 0);
    assert_eq!(graph.objects[0].fields["m_GRepId"], serde_json::json!(0));
    assert_eq!(graph.objects[1].fields["m_GRepId"], serde_json::json!(5));
    assert!(graph.objects[2].fields["m_GRepId"].is_null());
}

#[test]
fn normalize_legacy_tolere_les_graphes_vides_et_les_champs_non_objets() {
    let mut empty = graph(serde_json::json!([]));
    assert_eq!(native::normalize_legacy(&mut empty), 0);
    let mut odd = graph(serde_json::json!([object("InstanceInfo", serde_json::json!(null)), object("InstanceInfo", serde_json::json!(3))]));
    assert_eq!(native::normalize_legacy(&mut odd), 0);
}

/// Les drapeaux de face de Revit 2012 et 2013 (`m_faceFlags`, classe de version 8) : 4 et 6 passent dans `m_faceFlags_v9`
/// (le champ de la version 9, que lit le parcours de rvt-rs), les autres valeurs laissent `m_faceFlags_v9` absent.
#[test]
fn normalize_legacy_copie_les_drapeaux_de_face_mesures_et_aucun_autre() {
    let mut graph = graph(serde_json::json!([
        object("Face", serde_json::json!({ "m_faceFlags": 4 })),
        object("Face", serde_json::json!({ "m_faceFlags": 6 })),
        // Jamais vus dans un corps de 2012 ou 2013 : on ne devine pas leur sens.
        object("Face", serde_json::json!({ "m_faceFlags": 0 })),
        object("Face", serde_json::json!({ "m_faceFlags": 2 })),
        object("Face", serde_json::json!({ "m_faceFlags": 5 })),
        object("Face", serde_json::json!({ "m_faceFlags": 7 })),
        object("Face", serde_json::json!({ "m_faceFlags": 516 })),
        object("Face", serde_json::json!({ "m_faceFlags": 4294967295u64 })),
        object("Face", serde_json::json!({ "m_faceFlags": -4 })),
        object("Face", serde_json::json!({ "m_faceFlags": 4.0 })),
        object("Face", serde_json::json!({ "m_faceFlags": "4" })),
        object("Face", serde_json::json!({ "m_faceFlags": null })),
    ]));
    assert_eq!(native::normalize_legacy(&mut graph), 0, "seuls les InstanceInfo complétés sont comptés");
    assert_eq!(graph.objects[0].fields["m_faceFlags_v9"], serde_json::json!(4));
    assert_eq!(graph.objects[1].fields["m_faceFlags_v9"], serde_json::json!(6));
    for (i, object) in graph.objects.iter().enumerate().skip(2) {
        assert!(object.fields.get("m_faceFlags_v9").is_none(), "objet {i} : {:?}", object.fields);
    }
    // Le champ d'origine n'est jamais retiré.
    assert_eq!(graph.objects[0].fields["m_faceFlags"], serde_json::json!(4));
    // Idempotent.
    assert_eq!(native::normalize_legacy(&mut graph), 0);
    assert_eq!(graph.objects[1].fields["m_faceFlags_v9"], serde_json::json!(6));
}

#[test]
fn normalize_legacy_ne_touche_pas_m_face_flags_v9_ni_les_objets_sans_drapeau() {
    let mut graph = graph(serde_json::json!([
        // Revit 2014 et après : le champ v9 est déjà là, avec n'importe quelle valeur, jamais retouché.
        object("Face", serde_json::json!({ "m_faceFlags_v9": 516 })),
        object("Face", serde_json::json!({ "m_faceFlags_v9": 0 })),
        // Les deux ensemble : le champ v9 fait foi.
        object("Face", serde_json::json!({ "m_faceFlags": 4, "m_faceFlags_v9": 6 })),
        object("Plane", serde_json::json!({ "m_origin": [0, 0, 0] })),
        object("InstanceInfo", serde_json::json!({ "m_faceFlags": 6 })),
    ]));
    // L'`InstanceInfo` reçoit son `m_GRepId` ; son éventuel `m_faceFlags` passe comme celui de toute classe.
    assert_eq!(native::normalize_legacy(&mut graph), 1);
    assert_eq!(graph.objects[0].fields["m_faceFlags_v9"], serde_json::json!(516));
    assert_eq!(graph.objects[1].fields["m_faceFlags_v9"], serde_json::json!(0));
    assert_eq!(graph.objects[2].fields["m_faceFlags_v9"], serde_json::json!(6));
    assert!(graph.objects[3].fields.get("m_faceFlags_v9").is_none() && graph.objects[3].fields.get("m_faceFlags").is_none());
}

// ---------------------------------------------------------------------------------------------
// Fichiers réels
// ---------------------------------------------------------------------------------------------

fn options(channel: u64) -> Options {
    // Les mêmes plafonds que `geometry::saved::GRAPH_LIMIT`.
    Options { channels: BTreeSet::from([channel]), max_graph_values: 1_000_000, max_graph_objects: 1_000_000, ..Default::default() }
}

fn open(bytes: Vec<u8>) -> rvt::RevitFile {
    rvt::RevitFile::open_bytes(bytes).expect("fichier Revit lisible")
}

/// Ce qui compte d'un enregistrement pour une comparaison avec rvt-rs : tout sauf ce que le portage ne
/// calcule pas (`saved_metadata`, `effective_ifc_parameter`, `body_sha256`).
#[derive(Serialize)]
struct View<'a> {
    identity: &'a Identity,
    derived_default_ifc_guid: &'a Option<String>,
    derived_identifier_diagnostic: &'a Option<String>,
    channel: u64,
    class_name: &'a Option<String>,
    status: &'a str,
    diagnostic: &'a Option<String>,
    stream: &'a str,
    group: &'a GroupSource,
    group_record_offset: usize,
    body_bytes: usize,
    graph: &'a Option<ObjectGraph>,
}

struct HashWriter<'a>(&'a mut std::hash::DefaultHasher);

impl std::io::Write for HashWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.write(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Digest {
    channel: u64,
    id: u64,
    class: Option<String>,
    decoded: bool,
    hash: u64,
}

/// Le diagnostic d'un enregistrement refusé, sans son texte : rvt-rs décode l'enregistrement en entier avant de le
/// refuser et dit où il s'est arrêté ; le portage écarte d'emblée ceux que le budget refuserait de toute façon
/// (`native::records::OVERSIZE_BYTES_PER_VALUE`), avec un autre texte. Le refus lui-même, et tout le reste, sont comparés.
fn refused_marker(diagnostic: &Option<String>) -> Option<String> {
    diagnostic.as_ref().map(|_| "refusé".to_string())
}

fn digest(record: &Record) -> Digest {
    let diagnostic = refused_marker(&record.diagnostic);
    let view = View {
        identity: &record.identity,
        derived_default_ifc_guid: &record.derived_default_ifc_guid,
        derived_identifier_diagnostic: &record.derived_identifier_diagnostic,
        channel: record.channel,
        class_name: &record.class_name,
        status: &record.status,
        diagnostic: &diagnostic,
        stream: &record.source.stream,
        group: &record.source.group,
        group_record_offset: record.source.group_record_offset,
        body_bytes: record.source.body_bytes,
        graph: &record.graph,
    };
    let mut hasher = std::hash::DefaultHasher::new();
    serde_json::to_writer(HashWriter(&mut hasher), &view).expect("sérialisation d'un enregistrement");
    Digest { channel: record.channel, id: record.identity.element_id, class: record.class_name.clone(), decoded: record.graph.is_some(), hash: hasher.finish() }
}

/// Le bilan d'un `Summary`, sans les champs que le portage ne remplit pas.
fn summary_view(summary: &Summary) -> serde_json::Value {
    serde_json::json!({
        "revit_version": summary.revit_version,
        "schema_sha256": summary.schema_sha256,
        "indexed_elements": summary.indexed_elements,
        "graveyard_records": summary.graveyard_records,
        "selected_indexed_elements": summary.selected_indexed_elements,
        "emitted_records": summary.emitted_records,
        "complete_graph_records": summary.complete_graph_records,
        "unsupported_graph_records": summary.unsupported_graph_records,
        "refused_graph_ids": summary.refused_graph_ids,
        "refused_graph_classes": summary.refused_graph_classes,
        "max_graph_values_observed": summary.max_graph_values_observed,
        "max_graph_objects_observed": summary.max_graph_objects_observed,
        "skipped_embedded_content_groups": summary.skipped_embedded_content_groups,
        "skipped_historical_records": summary.skipped_historical_records,
        "current_records_outside_route": summary.current_records_outside_route,
        "requested_ids_absent_from_index": summary.requested_ids_absent_from_index,
        "selected_ids_without_records": summary.selected_ids_without_records,
        // Les diagnostics de refus par classe, comptés sans leur texte (voir `refused_marker`).
        "classes": summary.classes.iter().map(|(class, coverage)| (class.clone(), serde_json::json!({
            "records": coverage.records, "complete_graphs": coverage.complete_graphs, "unsupported_graphs": coverage.unsupported_graphs,
            "body_bytes": coverage.body_bytes, "complete_graph_body_bytes": coverage.complete_graph_body_bytes,
            "refusals": coverage.diagnostics.values().sum::<usize>(),
        }))).collect::<serde_json::Map<String, serde_json::Value>>(),
        "partitions": summary.partitions,
        "es_catalog": summary.extensible_storage_catalog.is_some(),
        "es_catalog_diagnostic": summary.extensible_storage_catalog_diagnostic,
    })
}

/// Les fichiers de 2023 et plus, en trois lots pour que les tests se partagent entre les fils : le
/// fixture du dépôt et les petits fichiers de `revit/samples/`, les moyens, puis Core Interior (34 Mo).
const RECENT_SMALL: [&str; 7] = [
    "tests/fixtures/Revit_IFC5_Einhoven.rvt",
    "samples/DynamoSample_2023.rvt",
    "samples/DynamoSample_2024.rvt",
    "samples/DynamoSample_2025.rvt",
    "samples/RE1-Architecture.rvt",
    "samples/RE1-Electrical.rvt",
    // Une famille de 2027 (adaptative) : même chemin que les projets.
    "samples/AdaptivePanel.rfa",
];
const RECENT_MEDIUM: [&str; 4] = ["samples/DuctSegmentFlow.rvt", "samples/RefineryPrimer-2023-BuildingGenerator.rvt", "samples/RefineryPrimer-2024-BuildingGenerator.rvt", "samples/RefineryPrimer-2026-BuildingGenerator.rvt"];
const RECENT_LARGE: [&str; 1] = ["samples/2024_Core_Interior.rvt"];

/// Lit un fichier de 2023 ou plus avec rvt-rs et avec notre portage (`native::extract_graphs`, le chemin
/// de toutes les années), et exige les mêmes enregistrements, dans le même ordre, et le même bilan.
fn assert_same_as_rvt_rs(relative: &str) {
    let Some(bytes) = sample_bytes(relative) else { return };
    let mut file = open(bytes);
    let version = file.basic_file_info().expect("BasicFileInfo").version;
    assert!(version >= 2023, "{relative} : année {version}");
    for channel in [102u64, 103] {
        let step = Instant::now();
        let mut reference = Vec::new();
        let reference_summary = native_document::extract_graphs(&mut file, &options(channel), |record| {
            reference.push(digest(&record));
            Ok(())
        })
        .expect("rvt-rs");

        let mut ported = Vec::new();
        let mut ported_ids = BTreeSet::new();
        let (ported_summary, framing) = native::extract_graphs_reporting(&mut file, &options(channel), |record| {
            // Un enregistrement du portage n'a ni métadonnées projetées, ni empreinte de corps.
            assert!(record.saved_metadata.is_none() && record.source.body_sha256.is_empty());
            ported_ids.insert(record.identity.element_id);
            ported.push(digest(&record));
            Ok(())
        })
        .expect("portage");

        assert!(!reference.is_empty(), "{relative} canal {channel} : aucun enregistrement");
        assert_eq!(ported.len(), reference.len(), "{relative} canal {channel} : nombre d'enregistrements");
        assert_eq!(ported_ids.len(), ported.len(), "{relative} canal {channel} : un identifiant revient");
        for (ours, theirs) in ported.iter().zip(&reference) {
            assert_eq!(ours, theirs, "{relative} canal {channel} : l'enregistrement {} diffère (classe {:?})", theirs.id, theirs.class);
        }
        assert_eq!(summary_view(&ported_summary), summary_view(&reference_summary), "{relative} canal {channel} : bilan");
        // L'encadrement attendu des années récentes, sans exception.
        assert_eq!(framing.unexpected_groups, 0, "{relative} canal {channel}");
        assert_eq!(framing.groups_by_id_width.keys().copied().collect::<Vec<_>>(), vec![if version >= 2024 { 8 } else { 4 }], "{relative} canal {channel}");
        assert_eq!(framing.groups_by_rule.keys().copied().collect::<Vec<_>>(), vec![DeclaredSize::Body], "{relative} canal {channel}");
        let decoded = reference.iter().filter(|digest| digest.decoded).count();
        eprintln!("{relative} ({version}) canal {channel} : {} enregistrements, {decoded} décodés, identiques à rvt-rs ({:.1} s)", reference.len(), step.elapsed().as_secs_f64());
    }
}

#[test]
fn le_portage_rend_ce_que_rvt_rs_rend_fichiers_petits() {
    for relative in RECENT_SMALL {
        assert_same_as_rvt_rs(relative);
    }
}

#[test]
fn le_portage_rend_ce_que_rvt_rs_rend_fichiers_moyens() {
    for relative in RECENT_MEDIUM {
        assert_same_as_rvt_rs(relative);
    }
}

#[test]
fn le_portage_rend_ce_que_rvt_rs_rend_core_interior() {
    for relative in RECENT_LARGE {
        assert_same_as_rvt_rs(relative);
    }
}

/// Ce qui a été mesuré sur un fichier ancien.
struct Legacy {
    file: &'static str,
    year: u32,
    /// Enregistrements du canal 102 refusés au plus (VarSketch, ImageHolder, une entité de stockage extensible).
    refused_102: usize,
}

/// Les cinq fichiers de la note de recherche (2016, 2017, 2019, 2020 ×2). La note comptait un refus de
/// plus en 2019 et 2020 (une entité de stockage extensible, `ProjectInfo` et `FamilyInstance`) : le
/// catalogue indulgent de `records.rs` les lit.
const LEGACY: [Legacy; 5] = [
    Legacy { file: "samples/Vignette-04-BaseFile.rvt", year: 2016, refused_102: 5 },
    Legacy { file: "samples/SampleModel.rvt", year: 2017, refused_102: 47 },
    Legacy { file: "samples/rac_advanced_sample_project.rvt", year: 2019, refused_102: 0 },
    Legacy { file: "samples/mega_advanced_sample_file.rvt", year: 2020, refused_102: 0 },
    Legacy { file: "samples/ConnectorTestR20.rvt", year: 2020, refused_102: 0 },
];

/// Les échantillons ajoutés ensuite (revit/samples.json) : 2015, 2018 (le seul de cette année : un
/// modèle de projet), 2021, 2022 et deux familles. Tous se lisent sans aucun refus.
const LEGACY_MORE: [Legacy; 7] = [
    Legacy { file: "samples/singleDirectShape.rvt", year: 2015, refused_102: 0 },
    Legacy { file: "samples/RiR-Template-2018.rte", year: 2018, refused_102: 0 },
    Legacy { file: "samples/RoomsAndExits.rvt", year: 2021, refused_102: 0 },
    Legacy { file: "samples/revit-curtainwall-byprofile_v21.rvt", year: 2021, refused_102: 0 },
    Legacy { file: "samples/CeilingType.rvt", year: 2022, refused_102: 0 },
    Legacy { file: "samples/revit-openings_v22.rvt", year: 2022, refused_102: 0 },
    Legacy { file: "samples/MassWithBoxAndCone.rfa", year: 2016, refused_102: 0 },
];

/// Lit les canaux 102 et 103 d'un fichier ancien avec `native::extract_graphs` et vérifie : aucune
/// erreur d'encadrement, l'encadrement attendu de l'année, un enregistrement courant par élément indexé,
/// 99,4 % au moins des graphes du canal 102 décodés (au plus `refused_102` refusés) et tous ceux du 103.
fn assert_legacy_decodes(relative: &str, year: u32, refused_102: usize) {
    let Some(bytes) = sample_bytes(relative) else { return };
    let mut file = open(bytes);
    assert_eq!(file.basic_file_info().expect("BasicFileInfo").version, year, "{relative}");
    for (channel, floor) in [(102u64, 99.4f64), (103, 100.0)] {
        let step = Instant::now();
        let mut ids = BTreeSet::new();
        let mut decoded = 0usize;
        let mut refused: BTreeMap<String, usize> = BTreeMap::new();
        let (summary, framing) = native::extract_graphs_reporting(&mut file, &options(channel), |record| {
            assert!(ids.insert(record.identity.element_id), "{relative} : l'élément {} revient", record.identity.element_id);
            assert_eq!(record.channel, channel);
            if record.graph.is_some() {
                decoded += 1;
            } else {
                *refused.entry(record.class_name.clone().unwrap_or_default()).or_default() += 1;
            }
            Ok(())
        })
        .unwrap_or_else(|error| panic!("{relative} canal {channel} : erreur d'encadrement ou de lecture : {error:#}"));
        let total = ids.len();
        let rate = 100.0 * decoded as f64 / total as f64;
        eprintln!("{relative} ({year}) canal {channel} : {total} enregistrements, {decoded} décodés ({rate:.2} %), refusés {refused:?}, encadrement {:?} {:?}, {:.2} s", framing.groups_by_id_width, framing.groups_by_rule, step.elapsed().as_secs_f64());

        // Encadrement : identifiants de 4 octets, la règle de l'année, pas d'exception, rien d'écarté.
        assert_eq!(framing.groups_by_id_width.keys().copied().collect::<Vec<_>>(), vec![4], "{relative} canal {channel}");
        assert_eq!(framing.unexpected_groups, 0, "{relative} canal {channel}");
        let expected_rule = if year <= 2017 { DeclaredSize::BodyAndTrailer } else { DeclaredSize::Body }; // 2018 : Body, mesuré sur son modèle de projet
        assert_eq!(framing.groups_by_rule.keys().copied().collect::<Vec<_>>(), vec![expected_rule], "{relative} canal {channel}");
        // Chaque enregistrement émis ou écarté comme historique a été encadré (les autres sont ceux
        // que l'index des éléments ne connaît pas).
        assert!(framing.records >= summary.emitted_records + summary.skipped_historical_records, "{relative} canal {channel}");
        assert!(framing.skipped_channels.values().sum::<usize>() > 0, "{relative} canal {channel} : les groupes des autres canaux ne sont pas encadrés");

        // Un enregistrement courant par élément indexé.
        assert_eq!(total, summary.indexed_elements, "{relative} canal {channel}");
        assert!(summary.selected_ids_without_records.is_empty(), "{relative} canal {channel}");
        assert_eq!(summary.complete_graph_records, decoded);

        // Taux de décodage de la note : 99,4 % au moins en 102, 100 % en 103.
        assert!(rate >= floor, "{relative} canal {channel} : {rate:.2} % décodés, attendu {floor} % au moins");
        if channel == 102 {
            assert!(total - decoded <= refused_102, "{relative} : {} refusés, au plus {refused_102} attendus : {refused:?}", total - decoded);
        } else {
            assert_eq!(decoded, total, "{relative} : graphes de canal 103 refusés : {refused:?}");
        }
    }
}

#[test]
fn decode_vignette_2016() {
    assert_legacy_decodes(LEGACY[0].file, LEGACY[0].year, LEGACY[0].refused_102);
}

#[test]
fn decode_sample_model_2017() {
    assert_legacy_decodes(LEGACY[1].file, LEGACY[1].year, LEGACY[1].refused_102);
}

#[test]
fn decode_rac_advanced_2019() {
    assert_legacy_decodes(LEGACY[2].file, LEGACY[2].year, LEGACY[2].refused_102);
}

#[test]
fn decode_mega_advanced_2020() {
    assert_legacy_decodes(LEGACY[3].file, LEGACY[3].year, LEGACY[3].refused_102);
}

#[test]
fn decode_connector_test_2020() {
    assert_legacy_decodes(LEGACY[4].file, LEGACY[4].year, LEGACY[4].refused_102);
}

#[test]
fn decode_les_echantillons_de_2015_2018_2021_2022_et_les_familles() {
    for legacy in &LEGACY_MORE {
        assert_legacy_decodes(legacy.file, legacy.year, legacy.refused_102);
    }
}

/// Un fichier d'avant 2015 d'essai : son année de lecture (celle de l'étiquette, ou, pour un fichier de Project Vasari, du schéma).
struct Pre2015 {
    file: &'static str,
    year: u32,
}

/// Les fichiers d'avant 2015 de `revit/samples.json` qui se lisent (le 21e, `tbc-exhaust-fan-build2007.rfa`, est de 2008 : autre
/// disposition des partitions, voir `tests/pre2015.rs`). Les deux fichiers de Project Vasari n'ont pas d'étiquette : leur
/// schéma est celui de 2012 et de 2014.
const PRE_2015: [Pre2015; 20] = [
    Pre2015 { file: "samples/void-cutter-2012.rfa", year: 2012 },
    Pre2015 { file: "samples/dynamo-solar-radiation-vasari2012.rvt", year: 2012 },
    Pre2015 { file: "samples/AdaptiveComponent-Revit2013.rfa", year: 2013 },
    Pre2015 { file: "samples/setout-point-2013.rfa", year: 2013 },
    Pre2015 { file: "samples/dynamo-nyc-site-2013.rvt", year: 2013 },
    Pre2015 { file: "samples/dynamo-tower-6-ds-2013.rfa", year: 2013 },
    Pre2015 { file: "samples/dynamo-pentagon-profile-2013.rfa", year: 2013 },
    Pre2015 { file: "samples/dynamo-inst-param-2013.rvt", year: 2013 },
    Pre2015 { file: "samples/dynamo-indexed-family-instances-2013.rfa", year: 2013 },
    Pre2015 { file: "samples/DividedCurve-Revit2014.rfa", year: 2014 },
    Pre2015 { file: "samples/dynamo-walls-floors-levels-2014.rvt", year: 2014 },
    Pre2015 { file: "samples/dynamo-structural-framing-2014.rvt", year: 2014 },
    Pre2015 { file: "samples/dynamo-create-wall-2014.rvt", year: 2014 },
    Pre2015 { file: "samples/dynamo-topography-2014.rvt", year: 2014 },
    Pre2015 { file: "samples/drone-hangar-building-2014.rvt", year: 2014 },
    Pre2015 { file: "samples/clockwork-wall-stuff-2014.rvt", year: 2014 },
    Pre2015 { file: "samples/clockwork-roof-floor-stuff-2014.rvt", year: 2014 },
    Pre2015 { file: "samples/dynamo-adaptive-component-2014.rfa", year: 2014 },
    Pre2015 { file: "samples/DynamoSample_2014.rvt", year: 2014 },
    Pre2015 { file: "samples/dynamo-reference-plane-vasari2013.rfa", year: 2014 },
];

/// Les enregistrements (total, décodés) de chaque canal de chaque année, sur les fichiers lus.
type Rates = BTreeMap<(u32, u64), (usize, usize)>;

/// Lit les canaux 102 et 103 d'un fichier d'avant 2015 : aucune erreur d'encadrement, l'encadrement de 2015 à 2017 (identifiant de
/// 4 octets, taille déclarée plus 4 par enregistrement), un enregistrement courant par élément indexé, tous les graphes du canal
/// 103 décodés. Les taux de décodage du canal 102 se jugent par année (`assert_pre2015_rates`), non par fichier : les fichiers
/// mesurés vont de 98,6 % à 99,8 %.
fn read_pre2015_rates(pre: &Pre2015, rates: &mut Rates) {
    let Some(bytes) = sample_bytes(pre.file) else { return };
    let mut file = open(bytes);
    assert_eq!(native::format_year(&mut file).map(|(year, _)| year), Some(pre.year), "{}", pre.file);
    for channel in [102u64, 103] {
        let step = Instant::now();
        let mut ids = BTreeSet::new();
        let mut decoded = 0usize;
        let mut refused: BTreeMap<String, usize> = BTreeMap::new();
        let (summary, framing) = native::extract_graphs_reporting(&mut file, &options(channel), |record| {
            assert!(ids.insert(record.identity.element_id), "{} : l'élément {} revient", pre.file, record.identity.element_id);
            if record.graph.is_some() {
                decoded += 1;
            } else {
                *refused.entry(record.class_name.clone().unwrap_or_default()).or_default() += 1;
            }
            Ok(())
        })
        .unwrap_or_else(|error| panic!("{} canal {channel} : erreur d'encadrement ou de lecture : {error:#}", pre.file));
        let total = ids.len();
        eprintln!("{} ({}) canal {channel} : {total} enregistrements, {decoded} décodés ({:.2} %), refusés {refused:?}, {:.2} s", pre.file, pre.year, 100.0 * decoded as f64 / total as f64, step.elapsed().as_secs_f64());
        assert_eq!(framing.groups_by_id_width.keys().copied().collect::<Vec<_>>(), vec![4], "{} canal {channel}", pre.file);
        assert_eq!(framing.unexpected_groups, 0, "{} canal {channel}", pre.file);
        assert_eq!(framing.groups_by_rule.keys().copied().collect::<Vec<_>>(), vec![DeclaredSize::BodyAndTrailer], "{} canal {channel}", pre.file);
        assert_eq!(total, summary.indexed_elements, "{} canal {channel}", pre.file);
        assert!(summary.selected_ids_without_records.is_empty(), "{} canal {channel}", pre.file);
        assert_eq!(summary.complete_graph_records, decoded);
        if channel == 103 {
            assert_eq!(decoded, total, "{} : graphes de canal 103 refusés : {refused:?}", pre.file);
        } else {
            // Les classes que rvt-rs refuse sur ces années, qu'aucune forme dessinée n'emploie.
            let others: Vec<&String> = refused.keys().filter(|class| !["VarSketch", "RefPlane", "Viewport", "ImageHolder"].contains(&class.as_str())).collect();
            eprintln!("{} : classes refusées hors des quatre mesurées : {others:?}", pre.file);
        }
        let entry = rates.entry((pre.year, channel)).or_default();
        entry.0 += total;
        entry.1 += decoded;
    }
}

/// Le taux de décodage du canal 102 de chaque année est au moins celui mesuré, moins une petite marge ; celui du canal 103 est de
/// 100 %. Mesuré sur les fichiers d'essai de `revit/samples.json` (agrégat de l'année) : 2012 : 99,42 %, 2013 : 99,46 % (99,36 % et
/// 99,47 % sur ceux de la recherche) et 2014 : 98,95 % (les 12 fichiers d'essai, dont le hangar à 98,57 % et DynamoSample_2014 à
/// 98,79 % qui pèsent lourd : les 99,07 % de la recherche portaient sur 37 fichiers de 2014). Les refus sont `VarSketch`,
/// `RefPlane`, `Viewport` et `ImageHolder`, qu'aucune forme dessinée n'emploie.
fn assert_pre2015_rates(rates: &Rates, years: &[u32]) {
    for (year, floor) in [(2012u32, 99.3f64), (2013, 99.4), (2014, 98.8)] {
        if !years.contains(&year) {
            continue;
        }
        for (channel, floor) in [(102u64, floor), (103, 100.0)] {
            let Some(&(total, decoded)) = rates.get(&(year, channel)) else { continue };
            let rate = 100.0 * decoded as f64 / total as f64;
            eprintln!("{year} canal {channel} : {decoded}/{total} décodés ({rate:.2} %)");
            assert!(rate >= floor, "{year} canal {channel} : {rate:.2} % décodés, attendu {floor} % au moins");
        }
    }
}

#[test]
fn decode_les_fichiers_de_2012_et_2013() {
    let mut rates = Rates::new();
    for pre in PRE_2015.iter().filter(|pre| pre.year <= 2013) {
        read_pre2015_rates(pre, &mut rates);
    }
    assert_pre2015_rates(&rates, &[2012, 2013]);
}

#[test]
fn decode_les_fichiers_de_2014() {
    let mut rates = Rates::new();
    for pre in PRE_2015.iter().filter(|pre| pre.year == 2014) {
        read_pre2015_rates(pre, &mut rates);
    }
    assert_pre2015_rates(&rates, &[2014]);
}

#[test]
fn le_portage_lit_aussi_un_fichier_ancien_par_classe_et_par_identifiant() {
    // Les sélections par identifiant et par classe de rvt-rs, sur un fichier ancien.
    let Some(bytes) = sample_bytes("samples/ConnectorTestR20.rvt") else { return };
    let mut file = open(bytes);
    let mut all = BTreeMap::new();
    native::extract_graphs(&mut file, &options(103), |record| {
        all.insert(record.identity.element_id, record.class_name.clone());
        Ok(())
    })
    .expect("lecture complète");
    let drawn: BTreeSet<u64> = all.iter().filter(|(_, class)| class.as_deref() == Some("GElement")).map(|(id, _)| *id).collect();
    assert!(!drawn.is_empty());

    let mut by_class = BTreeSet::new();
    let by_class_options = Options { selected_classes: BTreeSet::from(["GElement".to_string()]), ..options(103) };
    // Un enregistrement du canal 103 s'ouvre par la classe de son graphe : ici `GElement`.
    native::extract_graphs(&mut file, &by_class_options, |record| {
        by_class.insert(record.identity.element_id);
        Ok(())
    })
    .expect("par classe");
    assert_eq!(by_class, drawn);

    let some: BTreeSet<u64> = drawn.iter().copied().take(5).chain([u64::MAX - 1]).collect();
    let mut by_id = BTreeSet::new();
    let summary = native::extract_graphs(&mut file, &Options { selected_ids: some.clone(), ..options(103) }, |record| {
        by_id.insert(record.identity.element_id);
        Ok(())
    })
    .expect("par identifiant");
    assert_eq!(by_id, some.iter().copied().filter(|id| *id != u64::MAX - 1).collect::<BTreeSet<_>>());
    assert_eq!(summary.requested_ids_absent_from_index, vec![u64::MAX - 1]);
}

#[test]
fn le_catalogue_de_stockage_extensible_des_annees_2016_a_2020_se_lit() {
    // rvt-rs exige `m_specTypeId` à chaque champ d'entité ; Revit 2019 et 2020 ne l'écrivent pas.
    for (relative, entities) in [("samples/rac_advanced_sample_project.rvt", true), ("samples/ConnectorTestR20.rvt", true), ("samples/SampleModel.rvt", false)] {
        let Some(bytes) = sample_bytes(relative) else { continue };
        let mut file = open(bytes);
        let latest = native::read_single(&mut file, "Global/Latest").expect("Global/Latest");
        let preamble = native::read_preamble(&mut file).expect("préambule");
        let (catalog, _) = preamble.es_catalog.as_ref().unwrap_or_else(|error| panic!("{relative} : catalogue illisible : {error}"));
        let strict = rvt::research::native_es_catalog::decode(&latest, &preamble.registry);
        eprintln!("{relative} : catalogue de {} schémas ; rvt-rs seul : {}", catalog.schemas.len(), strict.as_ref().map_or_else(|error| format!("refus ({error})"), |(strict, _)| format!("{} schémas", strict.schemas.len())));
        if let Ok((strict, _)) = &strict {
            // Là où rvt-rs lit lui-même, le résultat est le sien.
            assert_eq!(strict.schemas.keys().collect::<Vec<_>>(), catalog.schemas.keys().collect::<Vec<_>>());
        } else {
            assert!(entities, "{relative} : rvt-rs refuse un catalogue que rien ne rend indulgent");
        }
        assert!(!catalog.schemas.is_empty() || !entities, "{relative}");
        for schema in catalog.schemas.values() {
            assert!(!schema.name.is_empty(), "{relative} : schéma sans nom");
        }
    }
}

#[test]
fn le_preambule_n_est_lu_qu_une_fois_par_fichier() {
    let Some(bytes) = sample_bytes("tests/fixtures/Revit_IFC5_Einhoven.rvt") else { return };
    native::clear_preamble_cache();
    let mut file = open(bytes.clone());
    let first = native::preamble(&mut file).expect("préambule");
    let second = native::preamble(&mut file).expect("préambule");
    assert!(Rc::ptr_eq(&first, &second));
    // Le même fichier rouvert : mêmes flux, même préambule.
    let mut reopened = open(bytes);
    assert!(Rc::ptr_eq(&first, &native::preamble(&mut reopened).expect("préambule")));
    // Un autre fichier le remplace.
    if let Some(other) = sample_bytes("samples/ConnectorTestR20.rvt") {
        let mut other_file = open(other);
        let third = native::preamble(&mut other_file).expect("préambule");
        assert!(!Rc::ptr_eq(&first, &third));
        assert_ne!(first.registry.source_sha256, third.registry.source_sha256);
    }
    native::clear_preamble_cache();
    let mut file = open(sample_bytes("tests/fixtures/Revit_IFC5_Einhoven.rvt").expect("fixture"));
    assert!(!Rc::ptr_eq(&first, &native::preamble(&mut file).expect("préambule")));
    assert!(!first.index.identities.is_empty());
}

#[test]
fn les_annees_lues_sont_2012_a_2027() {
    assert_eq!((*native::SUPPORTED_RELEASES.start(), *native::SUPPORTED_RELEASES.end()), (2012, 2027));
    assert!(native::LEGACY_RELEASES.contains(&2012) && native::LEGACY_RELEASES.contains(&2015) && native::LEGACY_RELEASES.contains(&2022));
    assert!(!native::LEGACY_RELEASES.contains(&2023) && !native::LEGACY_RELEASES.contains(&2011));
    // Le refus d'une année dit laquelle, en français.
    assert_eq!(
        native::unsupported(2011),
        "Revit antérieur à 2012 : ce fichier a été enregistré par Revit 2011, dont les enregistrements ne se lisent pas ici (la lecture commence à Revit 2012). Ouvrez-le dans Revit 2012 ou plus récent et enregistrez-le de nouveau."
    );
    assert!(native::unsupported(2008).contains("Revit 2008"));
    assert!(native::unsupported(2030).contains("plus récente"), "{}", native::unsupported(2030));
}

/// Un fichier enregistré avant Revit 2012 est refusé avant tout travail, en français. Aucun fichier de 2011 ou plus ancien
/// n'est un fichier d'essai : l'étiquette d'un fichier de 2013 est réécrite en « 2011 » (même longueur, rien d'autre ne bouge) ;
/// les deux chemins de lecture de l'étiquette passent par là : `BasicFileInfo` de rvt-rs (AdaptiveComponent) et le flux brut
/// (dynamo-pentagon-profile, dont rvt-rs refuse le `BasicFileInfo`).
#[test]
fn un_fichier_d_avant_2012_est_refuse_en_francais() {
    for relative in ["samples/AdaptiveComponent-Revit2013.rfa", "samples/dynamo-pentagon-profile-2013.rfa"] {
        let Some(bytes) = sample_bytes(relative) else { continue };
        let patched = relabel(&bytes, 2013, 2011);
        let mut file = open(patched.clone());
        assert_eq!(native::release(&mut file), Some(2011), "{relative}");
        let error = native::extract_graphs(&mut file, &options(102), |_| Ok(())).expect_err("lecture refusée");
        let message = format!("{error:#}");
        assert!(message.starts_with("Revit antérieur à 2012 : ") && message.contains("Revit 2011"), "{relative} : {message}");
        // La lecture complète refuse de même, avant tout travail.
        let error = revit::read(&patched, &revit::Options::default()).expect_err("lecture refusée");
        let message = format!("{error:#}");
        assert!(message.starts_with("Revit antérieur à 2012 : ") && message.contains("Revit 2011"), "{relative} : {message}");
        assert!(!message.contains("schema declared"), "{relative} : {message}");
        // Le fichier d'origine, lui, se lit.
        assert!(revit::read(&bytes, &revit::Options::default()).is_ok(), "{relative}");
    }
}

/// Les octets de `bytes` où l'étiquette « … AAAA (Build: » (UTF-16LE) de l'année `from` devient celle de `to`. Le texte est
/// cherché en octets : il est à l'alignement pair ou impair du flux, selon le fichier.
fn relabel(bytes: &[u8], from: u32, to: u32) -> Vec<u8> {
    let encode = |year: u32| -> Vec<u8> { format!("{year} (Build: ").encode_utf16().flat_map(u16::to_le_bytes).collect() };
    let (old, new) = (encode(from), encode(to));
    let mut out = bytes.to_vec();
    let mut replaced = 0;
    let mut at = 0;
    while at + old.len() <= out.len() {
        if out[at..at + old.len()] == old[..] {
            out[at..at + old.len()].copy_from_slice(&new);
            replaced += 1;
            at += old.len();
        } else {
            at += 1;
        }
    }
    assert!(replaced >= 1, "aucune étiquette de {from} à réécrire");
    out
}

#[test]
fn un_fichier_ancien_tronque_ou_abime_est_une_erreur_pas_une_panique() {
    let Some(bytes) = sample_bytes("samples/ConnectorTestR20.rvt") else { return };
    // Tronqué : le conteneur ne se lit plus, ou l'extraction échoue ; jamais de résultat partiel muet.
    for fraction in [3, 5, 7] {
        let cut = bytes[..bytes.len() * fraction / 10].to_vec();
        match rvt::RevitFile::open_bytes(cut) {
            Err(_) => {}
            Ok(mut file) => {
                let result = native::extract_graphs(&mut file, &options(102), |_| Ok(()));
                assert!(result.is_err(), "un fichier coupé à {fraction}/10 ne doit pas se lire");
            }
        }
    }
    // Octets abîmés dans le corps du fichier : une erreur ou une lecture complète, sans panique.
    let mut survived = 0;
    for position in [bytes.len() / 4, bytes.len() / 3, bytes.len() / 2, bytes.len() * 2 / 3, bytes.len() * 4 / 5] {
        let mut damaged = bytes.clone();
        for offset in 0..64 {
            damaged[position + offset] ^= 0xa5;
        }
        if let Ok(mut file) = rvt::RevitFile::open_bytes(damaged) {
            native::clear_preamble_cache();
            if native::extract_graphs(&mut file, &options(102), |_| Ok(())).is_ok() {
                survived += 1;
            }
        }
    }
    eprintln!("octets abîmés : {survived} lecture(s) sur 5 sont allées au bout");
}

// ---------------------------------------------------------------------------------------------
// Parcours d'une partition : des tailles lues dans le fichier, jamais crues
// ---------------------------------------------------------------------------------------------

/// Un lecteur qui compte ce qu'on lui a pris (le parcours ne doit pas lire la fin d'un fichier corrompu en entier).
struct Counting<R> {
    inner: R,
    taken: std::rc::Rc<std::cell::Cell<usize>>,
}

impl<R: std::io::Read> std::io::Read for Counting<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buffer)?;
        self.taken.set(self.taken.get() + n);
        Ok(n)
    }
}

/// Parcourt `bytes` comme une partition préparée, avec un budget de groupe de `max_group_bytes`.
fn walk(bytes: Vec<u8>, max_group_bytes: usize) -> (anyhow::Result<()>, usize) {
    let mut file = open(sample_bytes("tests/fixtures/Revit_IFC5_Einhoven.rvt").expect("fixture"));
    let preamble = native::preamble(&mut file).expect("préambule");
    let taken = std::rc::Rc::new(std::cell::Cell::new(0));
    let mut reader = Counting { inner: std::io::Cursor::new(bytes), taken: taken.clone() };
    let result = native::index::walk_prepared(&mut reader, &preamble.registry, max_group_bytes, |_, _, _| Ok(())).map(|_| ());
    (result, taken.get())
}

fn tag(name: &str) -> u16 {
    let mut file = open(sample_bytes("tests/fixtures/Revit_IFC5_Einhoven.rvt").expect("fixture"));
    native::preamble(&mut file).expect("préambule").registry.named(name).unwrap_or_else(|| panic!("classe {name}")).tag
}

/// Un en-tête de segment : balise, indicateurs, nombre d'objets, taille déclarée, taille brute, canal.
fn segment_header(flags: u32, size: u32) -> Vec<u8> {
    let mut out = vec![0u8; 8]; // les huit octets d'en-tête de la partition
    out.extend_from_slice(&tag("SegmentMarker").to_le_bytes());
    for value in [flags, 1, size, 0] {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out.extend_from_slice(&102u64.to_le_bytes());
    out
}

#[test]
fn une_taille_de_segment_corrompue_est_refusee_sans_allocation() {
    // 4 Gio − 16 octets déclarés : refusés d'après le budget de groupe, avant d'en lire un seul.
    let bytes = segment_header(0b100, u32::MAX - 8);
    let header = bytes.len();
    let (result, taken) = walk(bytes, 1 << 20);
    let message = format!("{:#}", result.expect_err("segment démesuré"));
    assert!(message.contains("au-delà du budget de groupe"), "{message}");
    assert!(taken <= header, "rien n'est lu au-delà de l'en-tête : {taken} octets pour {header}");

    // Une taille qui tient dans le budget, sur un fichier qui n'a pas les octets : tronqué, sans allouer la taille déclarée
    // (200 Mio, sous le budget par défaut de 256 Mio).
    let mut bytes = segment_header(0b100, 200 << 20);
    bytes.extend_from_slice(&[7; 32]);
    let (result, taken) = walk(bytes.clone(), 256 << 20);
    let message = format!("{:#}", result.expect_err("segment tronqué"));
    assert!(message.contains("tronquée"), "{message}");
    assert_eq!(taken, bytes.len());
}

#[test]
fn le_pied_opaque_d_une_partition_se_lit_au_plus_sur_une_page() {
    // Une marque de contenu de fin (jeton nul, compte 0xFFFFFFFF), suivie de dix mégaoctets : le pied dépasse une page, la
    // lecture le dit après avoir lu une page et un octet, non les dix mégaoctets.
    let page = revit_page_bytes();
    let mut head = vec![0u8; 8];
    head.extend_from_slice(&tag("ContentMarker").to_le_bytes());
    head.extend_from_slice(&0u32.to_le_bytes());
    head.extend_from_slice(&u32::MAX.to_le_bytes());
    let header = head.len();
    let mut bytes = head.clone();
    bytes.extend(std::iter::repeat_n(0u8, 10 << 20));
    let (result, taken) = walk(bytes, 1 << 20);
    let message = format!("{:#}", result.expect_err("pied démesuré"));
    assert!(message.contains("dépasse une page"), "{message}");
    assert!(taken <= header + page + 1 + 8192, "{taken} octets lus pour un en-tête de {header} et une page de {page}");
    // Un pied d'une page exactement est accepté.
    let mut bytes = head;
    bytes.extend(std::iter::repeat_n(0u8, page));
    let (result, _) = walk(bytes, 1 << 20);
    result.expect("un pied d'une page");
}

fn revit_page_bytes() -> usize {
    rvt::compression::REVIT_STORED_PAGE_BYTES
}
