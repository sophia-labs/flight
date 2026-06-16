# Flight Envelope Audit

This is a deterministic point-mass envelope sweep over the compiled aircraft models. It uses the same propulsion samplers, clean drag scalars, induced-drag approximation, Mach drag-rise model, variable-sweep schedule, and lift limit as the sim.

## Data Contract

- `scalars`: mass, wing loading, prop power, jet thrust, thrust-to-weight, drag area, critical altitude, fuel, sweep/Mach limits, and control-authority descriptors.
- `level[]`: altitude-speed samples with Mach, sweep, dynamic pressure, required lift coefficient, thrust, drag, excess thrust, specific excess power, climb rate, and level-flight feasibility.
- `turn[]`: altitude-speed samples with Mach, sweep, instantaneous load/rate/radius and sustained load/rate/radius.
- `summaries[]`: per-altitude stall speed, top level speed, best climb, corner speed, and best/minimum turn metrics.
- `acceleration[]`: deterministic level-flight acceleration windows; unavailable windows report the limiting reason.

## Aircraft Summary

| Aircraft | Stall mph | Top mph | Best climb | Service ceiling | Inst turn | Sust turn | Corner mph | 60-100 m/s |
| --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |
| Super Tomcat | 178 | 1,532 @ 14,000 m | 47,966 @ 772 | >18,000 m | 18.0 deg/s @ 514, R 734 m | 18.0 deg/s @ 514, R 734 m | 487 | below-stall |
| Long-Nose Escort | 92 | 425 @ 8,000 m | 2,997 @ 179 | 12,512 m | 36.3 deg/s @ 257, R 181 m | 17.8 deg/s @ 145, R 209 m | 253 | 21.9 s |
| Clipped-Wing Interceptor | 89 | 414 @ 6,000 m | 4,372 @ 190 | 11,947 m | 38.0 deg/s @ 246, R 166 m | 21.3 deg/s @ 145, R 174 m | 243 | 15.0 s |
| Radial Deck Fighter | 91 | 414 @ 8,000 m | 3,772 @ 179 | 12,895 m | 37.0 deg/s @ 246, R 171 m | 19.5 deg/s @ 145, R 191 m | 249 | 17.4 s |
| Featherweight Turn Fighter | 70 | 291 @ 4,000 m | 3,238 @ 134 | 10,211 m | 47.8 deg/s @ 190, R 102 m | 28.4 deg/s @ 123, R 111 m | 193 | 25.5 s |
| Twin-Boom Pursuit | 111 | 425 @ 8,000 m | 3,005 @ 190 | 12,154 m | 30.3 deg/s @ 302, R 256 m | 16.7 deg/s @ 179, R 275 m | 305 | 21.9 s |
| Wooden Fast Twin | 106 | 403 @ 6,000 m | 2,474 @ 190 | 11,578 m | 32.1 deg/s @ 291, R 232 m | 14.9 deg/s @ 157, R 270 m | 290 | 26.8 s |
| Late Prop Attack Brute | 102 | 324 @ 2,000 m | 2,197 @ 179 | 7,591 m | 33.4 deg/s @ 280, R 214 m | 14.2 deg/s @ 145, R 262 m | 278 | 30.2 s |
| Trainer Builder Mule | 69 | 201 @ 1,000 m | 1,566 @ 112 | 6,390 m | 49.2 deg/s @ 190, R 99 m | 23.7 deg/s @ 101, R 109 m | 188 | insufficient-excess-thrust |

## Historical Target Comparison

| Aircraft | Top speed | Climb | Service ceiling |
| --- | ---: | ---: | ---: |
| Super Tomcat | 1,532 / 1,544 mph (-1%) | 47,966 / 45,000 fpm (+7%) | >18,000 / 15,200 m (exceeds target) |
| Long-Nose Escort | 425 / 437 mph (-3%) | 2,997 / 3,200 fpm (-6%) | 12,512 / 12,770 m (-2%) |
| Clipped-Wing Interceptor | 414 / 405 mph (+2%) | 4,372 / 3,600 fpm (+21%) | 11,947 / 12,950 m (-8%) |
| Radial Deck Fighter | 414 / 446 mph (-7%) | 3,772 / 4,500 fpm (-16%) | 12,895 / 12,650 m (+2%) |
| Featherweight Turn Fighter | 291 / 329 mph (-12%) | 3,238 / 3,600 fpm (-10%) | 10,211 / 10,000 m (+2%) |
| Twin-Boom Pursuit | 425 / 414 mph (+3%) | 3,005 / 4,000 fpm (-25%) | 12,154 / 12,200 m (-0%) |
| Wooden Fast Twin | 403 / 415 mph (-3%) | 2,474 / 2,800 fpm (-12%) | 11,578 / 12,800 m (-10%) |
| Late Prop Attack Brute | 324 / 322 mph (+1%) | 2,197 / 2,850 fpm (-23%) | 7,591 / 8,690 m (-13%) |
| Trainer Builder Mule | 201 / 210 mph (-4%) | 1,566 / 1,200 fpm (+30%) | 6,390 / 7,070 m (-10%) |

## Per-Altitude Summaries

### Super Tomcat

| Alt m | Stall mph | Top mph | Best climb fpm | Inst turn | Sust turn | Corner mph |
| ---: | ---: | ---: | ---: | --- | --- | ---: |
| 0 | 178 | 772 | 47,966 | 18.0 deg/s @ 514, R 734 m | 18.0 deg/s @ 514, R 734 m | 487 |
| 1,000 | 188 | 828 | 47,410 | 16.7 deg/s @ 559, R 857 m | 16.7 deg/s @ 559, R 857 m | 515 |
| 2,000 | 199 | 872 | 46,299 | 15.5 deg/s @ 593, R 981 m | 15.5 deg/s @ 593, R 981 m | 545 |
| 4,000 | 223 | 973 | 43,709 | 13.2 deg/s @ 705, R 1,367 m | 12.6 deg/s @ 638, R 1,296 m | 611 |
| 6,000 | 250 | 1,096 | 40,808 | 11.0 deg/s @ 850, R 1,981 m | 10.2 deg/s @ 693, R 1,743 m | 684 |
| 8,000 | 280 | 1,230 | 37,717 | 9.2 deg/s @ 1,007, R 2,804 m | 8.1 deg/s @ 738, R 2,320 m | 767 |
| 10,000 | 314 | 1,376 | 34,539 | 8.0 deg/s @ 1,174, R 3,780 m | 6.4 deg/s @ 783, R 3,127 m | 859 |
| 12,000 | 351 | 1,476 | 32,981 | 7.0 deg/s @ 1,331, R 4,861 m | 5.0 deg/s @ 816, R 4,154 m | 963 |
| 14,000 | 394 | 1,532 | 31,183 | 6.2 deg/s @ 1,488, R 6,102 m | 4.0 deg/s @ 861, R 5,548 m | 1,078 |
| 16,000 | 441 | 1,365 | 12,880 | 5.2 deg/s @ 1,566, R 7,679 m | 2.8 deg/s @ 761, R 6,863 m | 1,208 |
| 18,000 | 494 | 1,141 | 3,958 | 4.1 deg/s @ 1,566, R 9,705 m | 1.6 deg/s @ 660, R 10,474 m | 1,354 |

### Long-Nose Escort

| Alt m | Stall mph | Top mph | Best climb fpm | Inst turn | Sust turn | Corner mph |
| ---: | ---: | ---: | ---: | --- | --- | ---: |
| 0 | 92 | 324 | 2,997 | 36.3 deg/s @ 257, R 181 m | 17.8 deg/s @ 145, R 209 m | 253 |
| 1,000 | 98 | 336 | 2,960 | 34.8 deg/s @ 268, R 197 m | 16.4 deg/s @ 145, R 227 m | 268 |
| 2,000 | 104 | 347 | 2,917 | 32.4 deg/s @ 280, R 221 m | 15.0 deg/s @ 157, R 267 m | 284 |
| 4,000 | 116 | 380 | 2,817 | 29.0 deg/s @ 313, R 277 m | 12.6 deg/s @ 168, R 341 m | 318 |
| 6,000 | 130 | 403 | 2,708 | 26.1 deg/s @ 358, R 351 m | 10.5 deg/s @ 179, R 436 m | 356 |
| 8,000 | 146 | 425 | 2,354 | 23.2 deg/s @ 403, R 444 m | 8.3 deg/s @ 201, R 619 m | 399 |
| 10,000 | 163 | 391 | 1,232 | 20.9 deg/s @ 447, R 549 m | 5.2 deg/s @ 235, R 1,164 m | 447 |
| 12,000 | 183 | 347 | 304 | 18.6 deg/s @ 503, R 694 m | 2.2 deg/s @ 268, R 3,139 m | 501 |
| 14,000 | 205 | n/a | 0 | 16.4 deg/s @ 570, R 892 m | n/a | 561 |
| 16,000 | 230 | n/a | 0 | 14.4 deg/s @ 649, R 1,153 m | n/a | 629 |
| 18,000 | 257 | n/a | 0 | 12.7 deg/s @ 727, R 1,466 m | n/a | 704 |

### Clipped-Wing Interceptor

| Alt m | Stall mph | Top mph | Best climb fpm | Inst turn | Sust turn | Corner mph |
| ---: | ---: | ---: | ---: | --- | --- | ---: |
| 0 | 89 | 347 | 4,372 | 38.0 deg/s @ 246, R 166 m | 21.3 deg/s @ 145, R 174 m | 243 |
| 1,000 | 94 | 369 | 4,333 | 36.3 deg/s @ 257, R 181 m | 19.5 deg/s @ 157, R 206 m | 257 |
| 2,000 | 99 | 380 | 4,289 | 33.9 deg/s @ 268, R 203 m | 18.1 deg/s @ 157, R 222 m | 272 |
| 4,000 | 111 | 403 | 4,199 | 30.4 deg/s @ 302, R 254 m | 15.3 deg/s @ 168, R 281 m | 305 |
| 6,000 | 125 | 414 | 3,361 | 27.0 deg/s @ 347, R 329 m | 11.8 deg/s @ 179, R 388 m | 341 |
| 8,000 | 140 | 391 | 2,038 | 24.3 deg/s @ 380, R 401 m | 7.9 deg/s @ 190, R 613 m | 382 |
| 10,000 | 156 | 358 | 971 | 21.6 deg/s @ 425, R 503 m | 4.7 deg/s @ 224, R 1,221 m | 428 |
| 12,000 | 175 | 291 | 76 | 19.4 deg/s @ 481, R 634 m | 1.1 deg/s @ 257, R 5,881 m | 480 |
| 14,000 | 196 | n/a | 0 | 17.1 deg/s @ 548, R 823 m | n/a | 538 |
| 16,000 | 220 | n/a | 0 | 15.2 deg/s @ 615, R 1,037 m | n/a | 602 |
| 18,000 | 246 | n/a | 0 | 13.3 deg/s @ 693, R 1,332 m | n/a | 675 |

### Radial Deck Fighter

| Alt m | Stall mph | Top mph | Best climb fpm | Inst turn | Sust turn | Corner mph |
| ---: | ---: | ---: | ---: | --- | --- | ---: |
| 0 | 91 | 313 | 3,772 | 37.0 deg/s @ 246, R 171 m | 19.5 deg/s @ 145, R 191 m | 249 |
| 1,000 | 96 | 324 | 3,725 | 34.8 deg/s @ 268, R 197 m | 17.8 deg/s @ 157, R 226 m | 264 |
| 2,000 | 102 | 336 | 3,677 | 33.4 deg/s @ 280, R 214 m | 16.5 deg/s @ 157, R 244 m | 279 |
| 4,000 | 114 | 369 | 3,572 | 29.8 deg/s @ 313, R 269 m | 13.9 deg/s @ 168, R 309 m | 313 |
| 6,000 | 128 | 391 | 3,446 | 26.3 deg/s @ 347, R 337 m | 11.7 deg/s @ 179, R 393 m | 351 |
| 8,000 | 143 | 414 | 2,962 | 23.7 deg/s @ 391, R 423 m | 9.2 deg/s @ 190, R 527 m | 393 |
| 10,000 | 161 | 380 | 1,623 | 21.0 deg/s @ 436, R 531 m | 5.9 deg/s @ 213, R 926 m | 440 |
| 12,000 | 180 | 347 | 521 | 18.8 deg/s @ 492, R 670 m | 2.8 deg/s @ 246, R 2,217 m | 493 |
| 14,000 | 202 | n/a | 0 | 16.7 deg/s @ 559, R 857 m | n/a | 552 |
| 16,000 | 226 | n/a | 0 | 14.7 deg/s @ 638, R 1,114 m | n/a | 619 |
| 18,000 | 253 | n/a | 0 | 12.9 deg/s @ 716, R 1,417 m | n/a | 693 |

### Featherweight Turn Fighter

| Alt m | Stall mph | Top mph | Best climb fpm | Inst turn | Sust turn | Corner mph |
| ---: | ---: | ---: | ---: | --- | --- | ---: |
| 0 | 70 | 257 | 3,238 | 47.8 deg/s @ 190, R 102 m | 28.4 deg/s @ 123, R 111 m | 193 |
| 1,000 | 74 | 268 | 3,212 | 45.2 deg/s @ 201, R 114 m | 25.9 deg/s @ 123, R 122 m | 204 |
| 2,000 | 79 | 280 | 3,174 | 42.6 deg/s @ 213, R 128 m | 24.0 deg/s @ 134, R 143 m | 216 |
| 4,000 | 88 | 291 | 2,559 | 38.0 deg/s @ 246, R 166 m | 19.1 deg/s @ 134, R 180 m | 242 |
| 6,000 | 99 | 268 | 1,583 | 34.1 deg/s @ 268, R 201 m | 13.4 deg/s @ 134, R 257 m | 271 |
| 8,000 | 111 | 246 | 802 | 30.6 deg/s @ 302, R 253 m | 8.3 deg/s @ 134, R 416 m | 304 |
| 10,000 | 124 | 213 | 156 | 27.1 deg/s @ 336, R 317 m | 3.0 deg/s @ 157, R 1,319 m | 340 |
| 12,000 | 139 | n/a | 0 | 24.5 deg/s @ 380, R 398 m | n/a | 381 |
| 14,000 | 156 | n/a | 0 | 21.8 deg/s @ 425, R 500 m | n/a | 427 |
| 16,000 | 175 | n/a | 0 | 19.4 deg/s @ 481, R 634 m | n/a | 478 |
| 18,000 | 196 | n/a | 0 | 17.1 deg/s @ 537, R 802 m | n/a | 536 |

### Twin-Boom Pursuit

| Alt m | Stall mph | Top mph | Best climb fpm | Inst turn | Sust turn | Corner mph |
| ---: | ---: | ---: | ---: | --- | --- | ---: |
| 0 | 111 | 336 | 3,005 | 30.3 deg/s @ 302, R 256 m | 16.7 deg/s @ 179, R 275 m | 305 |
| 1,000 | 118 | 347 | 2,964 | 28.8 deg/s @ 324, R 288 m | 15.3 deg/s @ 190, R 319 m | 323 |
| 2,000 | 125 | 358 | 2,924 | 27.0 deg/s @ 347, R 329 m | 13.9 deg/s @ 201, R 370 m | 342 |
| 4,000 | 140 | 391 | 2,830 | 24.2 deg/s @ 380, R 403 m | 11.9 deg/s @ 213, R 458 m | 383 |
| 6,000 | 157 | 414 | 2,720 | 21.5 deg/s @ 425, R 505 m | 10.0 deg/s @ 224, R 575 m | 429 |
| 8,000 | 176 | 425 | 2,056 | 19.4 deg/s @ 481, R 634 m | 7.6 deg/s @ 235, R 788 m | 481 |
| 10,000 | 197 | 391 | 1,018 | 17.1 deg/s @ 548, R 823 m | 4.7 deg/s @ 235, R 1,277 m | 539 |
| 12,000 | 220 | 324 | 157 | 15.1 deg/s @ 615, R 1,041 m | 1.6 deg/s @ 268, R 4,398 m | 604 |
| 14,000 | 247 | n/a | 0 | 13.3 deg/s @ 705, R 1,361 m | n/a | 676 |
| 16,000 | 277 | n/a | 0 | 11.7 deg/s @ 794, R 1,735 m | n/a | 758 |
| 18,000 | 310 | n/a | 0 | 10.3 deg/s @ 906, R 2,258 m | n/a | 849 |

### Wooden Fast Twin

| Alt m | Stall mph | Top mph | Best climb fpm | Inst turn | Sust turn | Corner mph |
| ---: | ---: | ---: | ---: | --- | --- | ---: |
| 0 | 106 | 324 | 2,474 | 32.1 deg/s @ 291, R 232 m | 14.9 deg/s @ 157, R 270 m | 290 |
| 1,000 | 112 | 336 | 2,429 | 29.9 deg/s @ 302, R 258 m | 13.5 deg/s @ 168, R 318 m | 307 |
| 2,000 | 119 | 347 | 2,380 | 28.7 deg/s @ 324, R 289 m | 12.5 deg/s @ 168, R 345 m | 325 |
| 4,000 | 133 | 369 | 2,279 | 25.3 deg/s @ 369, R 373 m | 10.4 deg/s @ 179, R 440 m | 364 |
| 6,000 | 149 | 403 | 2,159 | 22.6 deg/s @ 403, R 456 m | 8.6 deg/s @ 201, R 600 m | 408 |
| 8,000 | 167 | 391 | 1,772 | 20.4 deg/s @ 459, R 576 m | 6.6 deg/s @ 224, R 864 m | 457 |
| 10,000 | 187 | 358 | 768 | 18.2 deg/s @ 514, R 725 m | 3.7 deg/s @ 257, R 1,765 m | 512 |
| 12,000 | 209 | n/a | 0 | 16.0 deg/s @ 582, R 930 m | n/a | 574 |
| 14,000 | 235 | n/a | 0 | 14.1 deg/s @ 660, R 1,196 m | n/a | 643 |
| 16,000 | 263 | n/a | 0 | 12.4 deg/s @ 749, R 1,543 m | n/a | 720 |
| 18,000 | 294 | n/a | 0 | 10.9 deg/s @ 850, R 2,000 m | n/a | 807 |

### Late Prop Attack Brute

| Alt m | Stall mph | Top mph | Best climb fpm | Inst turn | Sust turn | Corner mph |
| ---: | ---: | ---: | ---: | --- | --- | ---: |
| 0 | 102 | 302 | 2,197 | 33.4 deg/s @ 280, R 214 m | 14.2 deg/s @ 145, R 262 m | 278 |
| 1,000 | 108 | 313 | 2,145 | 31.3 deg/s @ 291, R 238 m | 13.0 deg/s @ 145, R 286 m | 295 |
| 2,000 | 114 | 324 | 2,096 | 29.8 deg/s @ 313, R 269 m | 11.8 deg/s @ 157, R 339 m | 312 |
| 4,000 | 128 | 324 | 1,538 | 26.5 deg/s @ 347, R 335 m | 8.7 deg/s @ 168, R 495 m | 350 |
| 6,000 | 143 | 291 | 674 | 23.9 deg/s @ 391, R 420 m | 4.9 deg/s @ 190, R 991 m | 392 |
| 8,000 | 160 | n/a | 0 | 21.2 deg/s @ 436, R 528 m | n/a | 439 |
| 10,000 | 179 | n/a | 0 | 19.0 deg/s @ 492, R 664 m | n/a | 492 |
| 12,000 | 201 | n/a | 0 | 16.7 deg/s @ 559, R 857 m | n/a | 551 |
| 14,000 | 225 | n/a | 0 | 14.7 deg/s @ 626, R 1,091 m | n/a | 617 |
| 16,000 | 252 | n/a | 0 | 13.0 deg/s @ 716, R 1,407 m | n/a | 691 |
| 18,000 | 283 | n/a | 0 | 11.4 deg/s @ 816, R 1,827 m | n/a | 774 |

### Trainer Builder Mule

| Alt m | Stall mph | Top mph | Best climb fpm | Inst turn | Sust turn | Corner mph |
| ---: | ---: | ---: | ---: | --- | --- | ---: |
| 0 | 69 | 190 | 1,566 | 49.2 deg/s @ 190, R 99 m | 23.7 deg/s @ 101, R 109 m | 188 |
| 1,000 | 73 | 201 | 1,539 | 46.4 deg/s @ 201, R 111 m | 21.1 deg/s @ 112, R 136 m | 199 |
| 2,000 | 77 | 201 | 1,257 | 44.0 deg/s @ 213, R 124 m | 18.0 deg/s @ 112, R 159 m | 211 |
| 4,000 | 86 | 190 | 662 | 39.3 deg/s @ 235, R 153 m | 11.7 deg/s @ 112, R 245 m | 236 |
| 6,000 | 97 | 157 | 180 | 34.8 deg/s @ 268, R 197 m | 5.2 deg/s @ 123, R 608 m | 265 |
| 8,000 | 108 | n/a | 0 | 30.9 deg/s @ 302, R 250 m | n/a | 297 |
| 10,000 | 121 | n/a | 0 | 27.9 deg/s @ 336, R 309 m | n/a | 332 |
| 12,000 | 136 | n/a | 0 | 24.9 deg/s @ 369, R 380 m | n/a | 372 |
| 14,000 | 152 | n/a | 0 | 22.2 deg/s @ 414, R 477 m | n/a | 417 |
| 16,000 | 171 | n/a | 0 | 19.9 deg/s @ 470, R 605 m | n/a | 467 |
| 18,000 | 191 | n/a | 0 | 17.7 deg/s @ 526, R 762 m | n/a | 523 |

## Reading

- Instantaneous turn is limited by lift and the configured structural load limit.
- Sustained turn is the highest load factor that still has non-negative excess power at that speed and altitude.
- Corner speed is the speed where the lift limit reaches the configured structural load limit; it may sit above practical level speed for some aircraft.
- Service ceiling uses the conventional 100 ft/min climb threshold. A `>` ceiling means the aircraft still exceeds the threshold at the top of the configured altitude grid.
- This now includes first-order compressibility, wave drag, afterburning jet thrust lapse, q/Mach limits, and automatic sweep effects, but not detailed inlet maps, trim drag, compressor-stall probability, structural damage, prop torque/P-factor, or thermal limits.
