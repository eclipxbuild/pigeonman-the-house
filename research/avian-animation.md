# Avian animation support note

Checked 2026-11-05 against official Tripo developer documentation.

- Auto Rig lists `v2.5-20260210` as supporting avian rigs: https://developers.tripo3d.ai/en/docs/animations-rig
- Animation Retarget lists v2.5 preset identifiers for bipeds, quadrupeds, hexapods, octopods, serpentine and aquatic rigs. It does not list any avian preset: https://developers.tripo3d.ai/en/docs/animations-retarget
- Do not submit an undocumented animation identifier. The game should animate the saved avian skeleton through original in-engine procedural poses unless a supported avian preset is documented later.
