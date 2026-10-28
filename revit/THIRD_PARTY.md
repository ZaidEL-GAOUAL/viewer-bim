# Licences des composants tiers du lecteur Revit

Le lecteur Revit natif (dossier `revit/`, module WebAssembly livré dans `src/revit/pkg/`) repose sur
les composants ci-dessous. Le fichier `NOTICE` à la racine du dépôt les résume.

## 1. rvt-rs

Lecteur de fichiers Revit en Rust, sous licence **Apache-2.0**.
Dépôt : https://github.com/DrunkOnJava/rvt-rs, utilisé tel quel (aucune modification), dépendance
Cargo épinglée sur le commit `0304c038c6d90fdf2b14e5ed47aea1d0e65e4997`, avec la fonction
`unstable-research`. Il est compilé dans `src/revit/pkg/revit_bg.wasm`.

Texte de la licence :

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for describing the origin of the Work and
      reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Support. While redistributing the Work or
      Derivative Works thereof, You may choose to offer, and charge a
      fee for, acceptance of support, warranty, indemnity, or other
      liability obligations and/or rights consistent with this License.
      However, in accepting such obligations, You may act only on Your
      own behalf and on Your sole responsibility, not on behalf of any
      other Contributor, and only if You agree to indemnify, defend,
      and hold each Contributor harmless for any liability incurred by,
      or claims asserted against, such Contributor by reason of your
      accepting any such warranty or support.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2026 Griffin Long

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

Fichier NOTICE de rvt-rs, repris comme l'exige la section 4(d) de la licence Apache-2.0 :

```text
rvt-rs — open reader for Autodesk Revit files
Copyright 2026 Griffin Long

Licensed under the Apache License, Version 2.0 (see LICENSE).

==============================================================================
Trademark and attribution notices
==============================================================================

"Autodesk" and "Revit" are registered trademarks of Autodesk, Inc.
This project is not affiliated with, endorsed by, or sponsored by
Autodesk. All references to "Autodesk" and "Revit" in this project's
source, tests, documentation, and output are nominative fair use —
they identify the file format this reader parses, and no more.

This project neither uses nor distributes any Autodesk source code,
object code, proprietary SDK components, or header files. All
file-format observations documented here were obtained by inspecting
the bytes of files written by Autodesk Revit — publicly shipped
sample content — using only public tools (the Microsoft Compound
File Binary Format specification [MS-CFB], RFC 1952 gzip, and
standard Rust crates).

==============================================================================
Interoperability basis
==============================================================================

Reverse engineering for the sole purpose of achieving interoperability
between independently-developed software and the Autodesk Revit file
format is recognised as lawful fair use under:

  * United States — Sega Enterprises v. Accolade, 977 F.2d 1510
    (9th Cir. 1992); Sony Computer Entertainment v. Connectix, 203
    F.3d 596 (9th Cir. 2000).
  * European Union — Article 6 of Directive 2009/24/EC (Software
    Directive).
  * Australia — Copyright Act 1968, Section 47D.

File formats themselves are not copyrightable subject matter (Baker
v. Selden, 101 U.S. 99 (1879); Lotus Development v. Borland, 516
U.S. 233 (1996)). The Microsoft Compound File Binary Format is a
published public specification; the compression (RFC 1951 DEFLATE)
is an Internet standard.

No access-control or rights-management technology has been
circumvented by this project — the underlying Revit files are not
encrypted and carry no technological protection measures.

==============================================================================
Third-party dependencies (runtime)
==============================================================================

  cfb           — MIT OR Apache-2.0
  flate2        — MIT OR Apache-2.0
  encoding_rs   — Apache-2.0 OR MIT
  quick-xml     — MIT
  serde         — MIT OR Apache-2.0
  serde_json    — MIT OR Apache-2.0
  clap          — MIT OR Apache-2.0
  anyhow        — MIT OR Apache-2.0
  thiserror     — MIT OR Apache-2.0

See each dependency's own license for full terms. All runtime
dependencies are permissively licensed and compatible with
Apache-2.0 redistribution.

==============================================================================
Test-corpus attribution
==============================================================================

The integration test suite uses the publicly-available
`rac_basic_sample_family` RFA fixture family distributed by
Autodesk as part of every Revit release, and curated into a
Git-LFS-hosted repository by Andreas Philipp at
https://github.com/phi-ag/rvt under the Unlicense. The sample
family files themselves are Autodesk property; this project
consumes them only for interoperability-verification testing and
does not redistribute them (the phi-ag/rvt test corpus is pulled
via LFS from their repo at `git clone` time; it is not vendored
here).
```

## 2. Rhino.Inside.Revit

Les identifiants numériques des paramètres intégrés de Revit, leurs noms d'énumération (`WALL_BASE_OFFSET`) et
leurs identifiants ForgeTypeId, les groupes de paramètres et les catégories (identifiant, nom `OST_`, modèle ou
annotation) viennent des schémas de Rhino.Inside.Revit
(https://github.com/mcneel/rhino.inside-revit, dossier `src/RhinoInside.Revit.External/DB/Schemas/`, commit
`c8e2c5c3b6e70f89a3c66d71ee0015c3702d420f`), publié sous licence **MIT**. Le script `scripts/gen-revit-catalog.mjs`
les télécharge à ce commit et écrit les tables `revit/src/catalog/{parameters,groups,categories}.tsv`, compilées dans
le module WebAssembly.
Seuls ces identifiants et ces noms techniques sont repris ; aucun libellé d'Autodesk ni de Rhino.Inside.Revit n'est
copié. Les libellés français sont écrits pour ce projet (`revit/src/catalog/source/`), ou rendus à partir des
identifiants par le script.

```text
MIT License

Copyright (c) 2019 Robert McNeel & Associates

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 3. Bibliothèques Rust compilées dans le module WebAssembly

Pour chacune, la licence retenue est MIT ou Apache-2.0 quand elles sont proposées au choix ; les
textes sont donnés plus bas. Les macros utilisées seulement à la compilation (`syn`, `quote`,
`proc-macro2`, `serde_derive`, …) ne sont pas livrées et ne figurent pas ici. Liste établie avec
`cargo metadata` sur `revit/Cargo.lock` ; les mentions de droits d'auteur sont celles des fichiers de
licence de chaque bibliothèque.

| Bibliothèque | Version | Licence | Droits d'auteur |
| --- | --- | --- | --- |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | Les auteurs (Jonas Schievink, oyvindln) |
| allocator-api2 | 0.2.21 | MIT OR Apache-2.0 | Les auteurs (Zakarum) |
| anstream | 1.0.0 | MIT OR Apache-2.0 | Copyright (c) Individual contributors |
| anstyle | 1.0.14 | MIT OR Apache-2.0 | Copyright (c) Individual contributors |
| anstyle-parse | 1.0.0 | MIT OR Apache-2.0 | Copyright (c) Individual contributors |
| anstyle-query | 1.1.5 | MIT OR Apache-2.0 | Copyright (c) Individual contributors |
| anyhow | 1.0.104 | MIT OR Apache-2.0 | Les auteurs (David Tolnay) |
| block-buffer | 0.12.1 | MIT OR Apache-2.0 | Copyright (c) 2018-2025 The RustCrypto Project Developers |
| bumpalo | 3.20.3 | MIT OR Apache-2.0 | Copyright (c) 2019 Nick Fitzgerald |
| cfb | 0.15.0 | MIT | Copyright (c) 2017 Matthew D. Steele |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 | Copyright (c) 2014 Alex Crichton |
| clap | 4.6.7 | MIT OR Apache-2.0 | Copyright (c) Individual contributors |
| clap_builder | 4.6.7 | MIT OR Apache-2.0 | Copyright (c) Individual contributors |
| clap_lex | 1.1.1 | MIT OR Apache-2.0 | Copyright (c) Individual contributors |
| colorchoice | 1.0.5 | MIT OR Apache-2.0 | Copyright (c) Individual contributors |
| const-oid | 0.10.2 | Apache-2.0 OR MIT | Copyright (c) 2020-2026 The RustCrypto Project Developers |
| crc32fast | 1.5.3 | MIT OR Apache-2.0 | Copyright (c) 2018 Sam Rijs, Alex Crichton and contributors |
| crypto-common | 0.2.2 | MIT OR Apache-2.0 | Copyright (c) 2021-2026 RustCrypto Developers |
| digest | 0.11.3 | MIT OR Apache-2.0 | Copyright (c) 2017-2025 RustCrypto Developers; Copyright (c) 2017 Artyom Pavlov |
| earcut | 0.4.11 | MIT OR Apache-2.0 | Copyright (c) 2026 The GeoRust Project Developers |
| encoding_rs | 0.8.35 | (Apache-2.0 OR MIT) AND BSD-3-Clause | Copyright Mozilla Foundation |
| equivalent | 1.0.3 | Apache-2.0 OR MIT | Copyright (c) 2016-2023 Les auteurs de la bibliothèque |
| flate2 | 1.1.10 | MIT OR Apache-2.0 | Copyright (c) 2014-2026 Alex Crichton |
| fnv | 1.0.7 | Apache-2.0 / MIT | Copyright (c) 2017 Contributors |
| foldhash | 0.2.0 | Zlib | Copyright (c) 2024 Orson Peters |
| futures-core | 0.3.34 | MIT OR Apache-2.0 | Copyright (c) 2016 Alex Crichton; Copyright (c) 2017 The Tokio Authors |
| futures-task | 0.3.34 | MIT OR Apache-2.0 | Copyright (c) 2016 Alex Crichton; Copyright (c) 2017 The Tokio Authors |
| futures-util | 0.3.34 | MIT OR Apache-2.0 | Copyright (c) 2016 Alex Crichton; Copyright (c) 2017 The Tokio Authors |
| hashbrown | 0.16.1 | MIT OR Apache-2.0 | Copyright (c) 2016 Amanieu d'Antras |
| hybrid-array | 0.4.15 | MIT OR Apache-2.0 | Copyright (c) 2022-2026 The RustCrypto Project Developers |
| is_terminal_polyfill | 1.70.2 | MIT OR Apache-2.0 | Copyright (c) Individual contributors |
| itoa | 1.0.18 | MIT OR Apache-2.0 | Les auteurs (David Tolnay) |
| js-sys | 0.3.106 | MIT OR Apache-2.0 | Copyright (c) 2014 Alex Crichton |
| md-5 | 0.11.0 | MIT OR Apache-2.0 | Copyright (c) 2016-2026 The RustCrypto Project Developers; Copyright (c) 2016 Artyom Pavlov; Copyright (c) 2009-2013 Mozilla Foundation; Copyright (c) 2006-2009 Graydon Hoare |
| memchr | 2.8.3 | Unlicense OR MIT | Copyright (c) 2015 Andrew Gallant |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 | Copyright 2013-2014 RAD Game Tools and Valve Software; Copyright 2010-2014 Rich Geldreich and Tenacious Software LLC; Copyright (c) 2017 Frommi; Copyright (c) 2017-2024 oyvindln |
| num-traits | 0.2.19 | MIT OR Apache-2.0 | Copyright (c) 2014 The Rust Project Developers |
| once_cell | 1.21.4 | MIT OR Apache-2.0 | Les auteurs (Aleksey Kladov) |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT | Les auteurs de la bibliothèque |
| quick-xml | 0.42.0 | MIT | Copyright (c) 2016 Johann Tuffe |
| robust | 1.2.0 | MIT OR Apache-2.0 | Copyright (c) 2017 The Spade Developers; Copyright (c) 2020 The GeoRust Project Developers |
| serde | 1.0.229 | MIT OR Apache-2.0 | Les auteurs (Erick Tryzelaar, David Tolnay) |
| serde_core | 1.0.229 | MIT OR Apache-2.0 | Les auteurs (Erick Tryzelaar, David Tolnay) |
| serde_json | 1.0.154 | MIT OR Apache-2.0 | Les auteurs de la bibliothèque |
| sha2 | 0.11.0 | MIT OR Apache-2.0 | Copyright (c) 2016-2026 The RustCrypto Project Developers; Copyright (c) 2016 Artyom Pavlov; Copyright (c) 2009-2013 Mozilla Foundation; Copyright (c) 2006-2009 Graydon Hoare |
| simd-adler32 | 0.3.10 | MIT | Copyright (c) 2021 Marvin Countryman |
| slab | 0.4.12 | MIT | Copyright (c) 2019 Carl Lerche |
| smallvec | 1.16.4 | MIT OR Apache-2.0 | Copyright (c) 2018 The Servo Project Developers |
| spade | 2.15.1 | MIT OR Apache-2.0 | Copyright (c) 2017 The Spade Developers |
| strsim | 0.11.1 | MIT | Copyright (c) 2015 Danny Guo; Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>; Copyright (c) 2018 Akash Kurdekar |
| thiserror | 2.0.21 | MIT OR Apache-2.0 | Les auteurs (David Tolnay) |
| typenum | 1.20.1 | MIT OR Apache-2.0 | Copyright (c) 2014 Paho Lurie-Gregg |
| utf8parse | 0.2.2 | Apache-2.0 OR MIT | Copyright (c) 2016 Joe Wilm |
| uuid | 1.26.1 | Apache-2.0 OR MIT | Copyright (c) 2014 The Rust Project Developers; Copyright (c) 2018 Ashley Mannix, Christopher Armstrong, Dylan DPC, Hunar Roop Kahlon |
| wasm-bindgen | 0.2.129 | MIT OR Apache-2.0 | Copyright (c) 2014 Alex Crichton |
| wasm-bindgen-shared | 0.2.129 | MIT OR Apache-2.0 | Copyright (c) 2014 Alex Crichton |
| web-time | 1.1.0 | MIT OR Apache-2.0 | Copyright (c) 2023 dAxpeDDa |
| zlib-rs | 0.6.8 | Zlib | (C) 2024 Trifecta Tech Foundation |
| zmij | 1.0.23 | MIT | Les auteurs (David Tolnay) |

### Licence MIT

Texte commun à toutes les bibliothèques sous licence MIT, chacune avec la mention de droits
d'auteur du tableau ci-dessus :

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Licence Apache-2.0

Pour les bibliothèques proposées sous « MIT OR Apache-2.0 » et retenues sous Apache-2.0 : texte
identique à celui de la section 1.

### BSD-3-Clause (encoding_rs, données WHATWG)

```text
Copyright © WHATWG (Apple, Google, Mozilla, Microsoft).

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### Zlib (zlib-rs, foldhash)

```text
(C) 2024 Trifecta Tech Foundation 

This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.

2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.

3. This notice may not be removed or altered from any source distribution.
```

Même texte pour foldhash : « Copyright (c) 2024 Orson Peters ».

## 4. rvt-reader (baleti)

Les formules d'évaluation des surfaces enregistrées par Revit (cône, révolution, surface réglée) et de
leurs courbes de profil (ellipse, spline d'Hermite, NURBS), ainsi que le principe de lecture des
contours (chaque arête porte ses points (u, v) pour les deux faces qu'elle sépare, la surface d'un
cône part de son sommet), viennent de la documentation et du code de référence de **rvt-reader** de
baleti (https://github.com/baleti/rvt-reader : `GEOMETRY_API.md`, `NOTES.md`, `rvt_curves.py`,
`rvt_brep.py`), publié sous licence **MIT**. Elles y sont validées contre la géométrie de Revit
lui-même ; ici, elles sont réécrites en Rust dans `revit/src/geometry/faces/` (`surface.rs`,
`curve.rs`, `loops.rs`) et contrôlées contre les points d'arêtes que Revit enregistre
(`examples/faces.rs`, `tests/faces.rs`). Aucun fichier n'est copié ni exécuté.

```text
MIT License

Copyright (c) 2026 baleti

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 5. Extraction des enregistrements de rvt-rs (portage, Apache-2.0)

Le §1 dit que rvt-rs est utilisé sans modification : c'est vrai de la dépendance Cargo, qui reste
épinglée sur le même commit. En revanche, `revit/src/native/records.rs` reprend, réécrites sur l'API
publique de rvt-rs, trois fonctions : `extract_records` (lecture des partitions, routage des
enregistrements d'un élément vers sa partition courante, décodage des graphes, émission des
enregistrements) et `group_records` (découpage d'un groupe de segments en enregistrements), de son
fichier `src/native_document.rs`, et `decode` de `src/native_es_catalog.rs` (catalogue de stockage
extensible). rvt-rs réserve les deux premières à Revit 2023 à 2027 ; la version de `records.rs` les
ouvre à Revit 2012 à 2022, avec la largeur d'identifiant et la règle de taille déclarée de chaque année,
vérifiées sur les octets, et une arithmétique sans débordement sur 32 bits (WebAssembly). Le décodeur du
catalogue n'en diffère que par un champ facultatif (`m_specTypeId`, absent des fichiers de 2016 à 2020).
`revit/src/native/increments.rs` reprend de même `decode_increment_rows` (privée) de `src/native_index.rs`, les
contrôles des lignes de la table des incréments de stockage, pour lire la table locale d'une copie locale d'un
modèle partagé que rvt-rs refuse (`storage_increments` reste d'abord appelée, et rend seule le résultat de tout
autre fichier).

Pour les fichiers de Revit 2012 à 2014 (rvt-rs refuse leur préambule), deux autres fichiers reprennent des fonctions de rvt-rs,
toujours appelées après lui et seulement quand il refuse et que l'année du fichier est d'avant 2015 :
- `revit/src/native/schema.rs` reprend `parse` de `src/schema_registry.rs` (lecture du schéma des classes, `Formats/Latest`) avec
  un seul interrupteur, le compte d'entrées opaques de 16 octets qui termine chaque classe (présent en 2014, absent en 2012 et en
  2013), et rend le `Registry` de rvt-rs ; elle porte aussi la table des empreintes des schémas de 2012, 2013 et 2014, qui date
  un fichier sans étiquette « Autodesk Revit » (Project Vasari) ;
- `revit/src/native/elemtable.rs` reprend `parse`, `fixed_layout` et `leaf_value` de `src/native_index.rs` (l'index des éléments,
  `Global/ElemTable`), où le jeton du pointeur `m_pSource` doit valoir exactement 2 (Revit 2012 à 2014) au lieu de `u32::MAX`
  (Revit 2015 et après).

Ce portage est une œuvre dérivée de rvt-rs : il reste sous **Apache-2.0** (texte au §1), Copyright 2026
Griffin Long pour les parties reprises, commit `0304c038c6d90fdf2b14e5ed47aea1d0e65e4997`. Les
modifications sont décrites dans l'en-tête de chaque fichier. À relire à chaque changement du commit épinglé.

## 6. Parcours des graphiques de rvt-rs (portage, Apache-2.0)

`revit/src/geometry/faces/select.rs` reprend, réécrit sur l'API publique de rvt-rs, le parcours des
graphiques enregistrés de `src/native_graphics_traversal.rs` (sélection des nœuds `Geometry` et
`GPolyMesh`, transformations des instances, visibilité des groupes, conditions de direction, de niveau de
détail et de type de vue). Il en diffère par ce que les octets des fichiers d'essai permettent de lire
(commandes de retournement, imposteurs, composants imbriqués, instances à cibles interdites, instances à symbole
résolu dans la vue, groupes étiquetés, familles de détail imbriquées : voir l'en-tête du fichier) et par ses index d'arêtes gardés d'une instance à
l'autre. `revit/src/geometry/faces/mod.rs` reprend de même la lecture des `GPolyMesh` et la transformation
des primitives de `src/native_saved_mesh.rs`, avec les normales par sommet et par facette.

Ces portages sont des œuvres dérivées de rvt-rs : ils restent sous **Apache-2.0** (texte au §1), Copyright 2026
Griffin Long pour les parties reprises, commit `0304c038c6d90fdf2b14e5ed47aea1d0e65e4997`. Les modifications
sont décrites dans l'en-tête de chaque fichier. À relire à chaque changement du commit épinglé.
