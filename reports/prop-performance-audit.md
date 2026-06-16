# Prop Performance Audit

This is a headless, point-mass estimate from the compiled airframes. It uses the same propeller sampler and approximate aerodynamic constants as the sim, then compares each archetype to a rough historical-family benchmark.

| Archetype | Reference family | Sim max mph | Ref max mph | Speed | Stall mph | Ref stall | Stall | Climb fpm | Ref climb | Climb | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Long-Nose Escort | P-51D Mustang | 425 @ 8,000 m | 437 | 97% | 92 | 100 | 92% | 3,001 | 3,200 | 94% | plausible |
| Clipped-Wing Interceptor | late Merlin Spitfire / Yak-3 family | 418 @ 6,000 m | 405 | 103% | 89 |  |  | 4,372 | 3,600 | 121% | plausible |
| Radial Deck Fighter | F4U-4 Corsair | 414 @ 8,000 m | 446 | 93% | 91 |  |  | 3,772 | 4,500 | 84% | plausible |
| Featherweight Turn Fighter | A6M2 Zero / Yak-3 light fighter family | 291 @ 4,000 m | 329 | 88% | 70 | 69 | 102% | 3,244 | 3,600 | 90% | plausible |
| Twin-Boom Pursuit | P-38L Lightning | 425 @ 8,000 m | 414 | 103% | 111 |  |  | 3,006 | 4,000 | 75% | plausible |
| Wooden Fast Twin | DH.98 Mosquito | 405 @ 6,000 m | 415 | 98% | 106 |  |  | 2,474 | 2,800 | 88% | plausible |
| Late Prop Attack Brute | A-1H Skyraider | 327 @ 4,000 m | 322 | 101% | 102 |  |  | 2,198 | 2,850 | 77% | plausible |
| Trainer Builder Mule | T-6G Texan | 206 @ 1,000 m | 210 | 98% | 69 |  |  | 1,570 | 1,200 | 131% | plausible |

## Sim Scalars

| Archetype | Mass kg | Power hp | Critical altitude m | Wing area m2 | Wing loading N/m2 | T/W | Parasite area m2 | Best climb speed mph |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Long-Nose Escort | 4,254 | 1,520 | 7,600 | 25.7 | 1,622 | 0.59 | 0.27 | 183 |
| Clipped-Wing Interceptor | 3,261 | 1,565 | 5,000 | 21.5 | 1,490 | 0.78 | 0.23 | 190 |
| Radial Deck Fighter | 5,582 | 2,450 | 7,500 | 34.8 | 1,573 | 0.73 | 0.56 | 179 |
| Featherweight Turn Fighter | 2,600 | 980 | 3,000 | 27.1 | 940 | 0.76 | 0.27 | 130 |
| Twin-Boom Pursuit | 8,375 | 3,000 | 7,000 | 34.8 | 2,358 | 0.62 | 0.56 | 188 |
| Wooden Fast Twin | 10,325 | 3,420 | 7,500 | 47.6 | 2,128 | 0.53 | 0.67 | 190 |
| Late Prop Attack Brute | 8,848 | 2,700 | 3,000 | 44.3 | 1,962 | 0.50 | 0.70 | 177 |
| Trainer Builder Mule | 2,545 | 600 | 1,200 | 27.8 | 897 | 0.59 | 0.37 | 107 |

## Benchmark Sources

- P-51D Mustang: Palm Springs Air Museum (https://palmspringsairmuseum.org/p-51-mustang/) / AOPA P-51D spec sheet (https://www.aopa.org/news-and-media/all-news/2007/august/01/north-american-aviation-p-51d-mustang).
- late Merlin Spitfire / Yak-3 family: American Heritage Museum Spitfire Mk IX notes (https://www.americanheritagemuseum.org/aircrafts/supermarine-spitfire-mk-ix/) / Military Aviation Museum Yak-3M specs (https://www.militaryaviationmuseum.org/aircraft/yakovlev-yak-3m/).
- F4U-4 Corsair: USS Midway Museum F4U specs (https://www.midway.org/visit/aircraft-gallery/f4u-corsair) / National Museum of World War II Aviation F4U notes (https://www.worldwariiaviation.org/aircraft/chance-vought-f4u-corsair).
- A6M2 Zero / Yak-3 light fighter family: Pearl Harbor Aviation Museum Zero speed note (https://www.pearlharboraviationmuseum.org/news/blog-archives/how-fast-was-the-zero/) / Military Aviation Museum Yak-3M specs (https://www.militaryaviationmuseum.org/aircraft/yakovlev-yak-3m/).
- P-38L Lightning: National Museum of the USAF P-38L specs (https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/196280/lockheed-p-38l-lightning/) / Museum of Flight P-38L specs (https://www.museumofflight.org/exhibits-and-events/aircraft/lockheed-p-38l-lightning).
- DH.98 Mosquito: National Museum of the USAF Mosquito fact sheet (https://www.nationalmuseum.af.mil/Visit/Museum-Exhibits/Fact-Sheets/Display/Article/196281/de-havilland-dh-98-mosquito/).
- A-1H Skyraider: Tennessee Museum of Aviation A-1H specs (https://www.tnairmuseum.com/aircraft/douglas-a-1h-skyraider-lieutenant-america/) / National Naval Aviation Museum A-1H notes (https://navalaviationmuseum.org/a-1h-skyraider/).
- T-6G Texan: Museum of Aviation Foundation T-6G specs (https://museumofaviation.org/portfolio/t-6g/) / Warhawk Air Museum T-6G specs (https://warhawkairmuseum.org/explore/aviation-collection/t-6g/).

## Reading

- `too slow` here means the estimated max level speed is below 78% of the reference-family top speed.
- `too fast` means above 112%; `climbs hot` means above 150% of the reference climb rate; `climbs weak` means below 55%.
- These are ballpark checks, not flight-manual reproduction: the sim now models constant-speed pitch scheduling and a single critical-altitude power hold, but not supercharger gear changes, compressibility, detailed prop efficiency maps, or thermal limits.
