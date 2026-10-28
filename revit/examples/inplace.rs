//! Le contenu des familles sur place et ce que la lecture en fait (`geometry::Stats::in_place`) :
//! `cargo run --release --example inplace -- <fichier.rvt>...`
//!
//! Une ligne par forme du contenu dessiné d'une famille sur place (séparée par des tabulations) :
//! fichier, famille, décision (`écarté` : une instance dessinée porte autant de triangles ; `masse masquée` : l'instance est une masse
//! que Revit masque par défaut, le contenu l'est aussi ; `gardé` : dessiné comme avant, avec un avertissement), classe, identifiant et triangles de l'élément, sa boîte (dimensions, mètres), puis, pour chaque instance de la
//! famille que la lecture a dessinée : identifiant, source, triangles, dimensions de sa boîte, et son déplacement par rapport à la
//! boîte du contenu de la famille (le coin bas, repère du maillage : X, Y vers le haut, Z).
//!
//! Les éléments dessinés que la famille possède sans être des formes de sa définition (un mur, un toit : des éléments du modèle, que
//! l'instance ne dessine pas) suivent, une ligne chacun, sans instance.
//!
//! Le tableau sert à vérifier, famille par famille, que l'instance dessine bien ce que l'on n'a pas dessiné (mêmes triangles, mêmes
//! dimensions, à sa place), et à compter ce qui reste dessiné à sa place d'origine.

use std::process::ExitCode;

use revit::geometry;
use revit::Context;

fn size(extent: Option<[[f64; 3]; 2]>) -> String {
    extent.map_or_else(|| "-".to_string(), |[low, high]| format!("{:.3}x{:.3}x{:.3}", high[0] - low[0], high[1] - low[1], high[2] - low[2]))
}

fn main() -> ExitCode {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.is_empty() {
        eprintln!("usage : inplace <fichier.rvt>...");
        return ExitCode::FAILURE;
    }
    for path in &paths {
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        let Ok(bytes) = std::fs::read(path) else {
            eprintln!("{name} : illisible");
            continue;
        };
        let Ok(mut file) = rvt::RevitFile::open_bytes(bytes) else {
            eprintln!("{name} : ce n'est pas un fichier Revit");
            continue;
        };
        let release = revit::native::format_year(&mut file).map(|(year, _)| year);
        let mut context = Context::new(release);
        let built = match geometry::build(&mut file, &mut context) {
            Ok(built) => built,
            Err(error) => {
                eprintln!("{name} : {error:#}");
                continue;
            }
        };
        let (mut excluded, mut masses, mut kept) = (0usize, 0usize, 0usize);
        for family in &built.stats.in_place {
            let decision = if family.excluded {
                "écarté"
            } else if family.mass {
                "masse masquée"
            } else {
                "gardé"
            };
            if family.excluded {
                excluded += family.content.len();
            } else if family.mass {
                masses += family.content.len();
            } else {
                kept += family.content.len();
            }
            // La boîte du contenu de la famille (réunion de celles de ses éléments) et ses triangles.
            let union = family.content.iter().filter_map(|content| content.extent).reduce(|a, b| [[a[0][0].min(b[0][0]), a[0][1].min(b[0][1]), a[0][2].min(b[0][2])], [a[1][0].max(b[1][0]), a[1][1].max(b[1][1]), a[1][2].max(b[1][2])]]);
            let triangles: usize = family.content.iter().map(|content| content.triangles).sum();
            for content in &family.content {
                let low = |extent: Option<[[f64; 3]; 2]>| extent.map_or_else(|| "-".to_string(), |[low, _]| format!("({:.3},{:.3},{:.3})", low[0], low[1], low[2]));
                let mut line = format!("{name}\t{}\t{decision}\t{}\t{}\t{}\t{}\tbas {}", family.family, content.class, content.id, content.triangles, size(content.extent), low(content.extent));
                if family.instances.is_empty() {
                    line.push_str("\t(aucune instance dessinée)");
                }
                for instance in &family.instances {
                    let shift = match (union, instance.extent) {
                        (Some(own), Some(placed)) => format!("{:+.3},{:+.3},{:+.3}", placed[0][0] - own[0][0], placed[0][1] - own[0][1], placed[0][2] - own[0][2]),
                        _ => "-".to_string(),
                    };
                    let same = if instance.triangles == triangles { "mêmes triangles" } else { "triangles différents" };
                    line.push_str(&format!("\t{}\tsource {}\t{} triangles\t{}\tbas {}\t{shift}\t{same} (contenu {triangles})", instance.id, instance.source, instance.triangles, size(instance.extent), low(instance.extent)));
                }
                println!("{line}");
            }
        }
        for (family, id, class) in &built.stats.in_place_standalone {
            println!("{name}\t{family}\tnon forme, dessiné\t{class}\t{id}");
        }
        eprintln!("{name} : {} familles sur place dessinées, contenu écarté {excluded}, masse masquée {masses}, gardé {kept} ; règle comptée {}", built.stats.in_place.len(), built.stats.rules.get(geometry::classes::RELATION_REASONS[8]).copied().unwrap_or(0));
        for family in built.stats.in_place.iter().filter(|family| !family.excluded && !family.mass) {
            let drawn: Vec<u64> = family.content.iter().map(|content| content.id).filter(|id| built.element_ids.contains(id)).collect();
            eprintln!("  famille {} gardée : {} éléments, {} remis à la sortie", family.family, family.content.len(), drawn.len());
        }
        for warning in context.warnings.iter().filter(|warning| warning.contains("sur place")) {
            eprintln!("  avertissement : {warning}");
        }
    }
    ExitCode::SUCCESS
}
