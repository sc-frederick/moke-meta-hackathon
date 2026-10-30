# Florida Building Code (2023, 8th Edition) - Plan Review Reference

Purpose: context file for an automated plan-review agent. It maps the key requirements a reviewer must check on commercial and residential projects in Florida to the governing code sections, with deep links to the official text on ICC Digital Codes. It intentionally contains NO copied code text; always resolve the link and read the current section before citing a requirement.

## How to use this file
- Statewide code in effect: 2023 Florida Building Code, 8th Edition (effective December 31, 2023). Source of truth: https://codes.iccsafe.org/codes/united-states/florida
- Commercial and multifamily (3+ stories or outside FBC-R scope): use FBC Building plus the trade volumes (Mechanical, Plumbing, Fuel Gas), Energy Conservation [CE], and Accessibility.
- 1- and 2-family dwellings and townhouses up to 3 stories: use FBC Residential (its Parts V-VIII carry the residential M/G/P/E provisions), Energy Conservation [RE], and Accessibility where public accommodation applies.
- Renovation, alteration, repair, change of occupancy, addition, or relocated building: start in FBC Existing Building to classify the work, then apply the referenced volume provisions.
- High-Velocity Hurricane Zone (HVHZ) = Miami-Dade and Broward counties: the HVHZ sections listed under FBC Building and FBC Residential Ch. 44 supersede the general provisions there.
- Supplements adopted after this crawl are not integrated into the linked text; check the Florida Building Commission list at https://www.floridabuilding.org/fbc/Links_to_Code_Resources.html
- Link anchor convention: chapter URL + #{DOC}_Ch{NN}_Sec{number}. Every link below was verified against the live pages on 2026-07-09 (chapter URL returns the chapter and the anchor id exists in the rendered DOM). ICC pages are JavaScript-rendered; a plain HTTP GET returns a shell, so automated consumers should render the page or use the anchor id to locate the section.

## Volume index (verified base URLs)
| Volume | Doc ID | URL |
|---|---|---|
| Building (commercial) | FLBC2023P2 | https://codes.iccsafe.org/content/FLBC2023P2 |
| Residential | FLRC2023P2 | https://codes.iccsafe.org/content/FLRC2023P2 |
| Existing Building | FLEBC2023P2 | https://codes.iccsafe.org/content/FLEBC2023P2 |
| Energy Conservation | FLEC2023P1 | https://codes.iccsafe.org/content/FLEC2023P1 |
| Accessibility | FLAC2023P1 | https://codes.iccsafe.org/content/FLAC2023P1 |
| Mechanical | FLMC2023P2 | https://codes.iccsafe.org/content/FLMC2023P2 |
| Plumbing | FLPC2023P2 | https://codes.iccsafe.org/content/FLPC2023P2 |
| Fuel Gas | FLFGC2023P1 | https://codes.iccsafe.org/content/FLFGC2023P1 |

---
## FBC Building (Commercial) - 2023 8th Edition
Base: [2023 FBC Building](https://codes.iccsafe.org/content/FLBC2023P2)

### Administration & Permits
- **104 Duties and Powers of the Building Official** - Confirm the official's authority for approvals, alternative materials/methods, and modifications is respected in the submittal. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-1-scope-and-administration#FLBC2023P2_Ch01_SubCh02_Sec104)
- **105 Permits** - Verify the work requires a permit, is not exempt, and that permit scope matches the drawings. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-1-scope-and-administration#FLBC2023P2_Ch01_SubCh02_Sec105)
- **106 Floor and Roof Design Loads** - Check that design live/roof loads are shown and the required load placard is provided. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-1-scope-and-administration#FLBC2023P2_Ch01_SubCh02_Sec106)
- **107 Submittal Documents** - Confirm construction documents, a site plan, and signed/sealed engineering are complete and adequately detailed. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-1-scope-and-administration#FLBC2023P2_Ch01_SubCh02_Sec107)
- **110 Inspections** - Verify the required inspection sequence and any threshold/special-inspector reporting is provided for. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-1-scope-and-administration#FLBC2023P2_Ch01_SubCh02_Sec110)
- **111 Certificate of Occupancy** - Confirm the occupancy/use, construction type, and load data needed for the CO are established. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-1-scope-and-administration#FLBC2023P2_Ch01_SubCh02_Sec111)
- **117 Variances in Flood Hazard Areas** - Check any flood-area variance request against the limited grounds the code allows. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-1-scope-and-administration#FLBC2023P2_Ch01_SubCh02_Sec117)
- **Chapter 2 Definitions** - Reference for defined terms controlling code interpretation throughout the review. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-2-definitions#FLBC2023P2_Ch02)

### Occupancy & Height/Area
- **302 Occupancy Classification** - Verify each space is assigned a correct occupancy group and use designation. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-3-use-and-occupancy-classification#FLBC2023P2_Ch03_Sec302)
- **303 Assembly Group A / 304 Business B / 309 Mercantile M / 311 Storage S** - Confirm the specific commercial group criteria and occupant thresholds fit the proposed use. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-3-use-and-occupancy-classification#FLBC2023P2_Ch03_Sec304)
- **307 High-Hazard Group H** - Check whether hazardous materials or processes push the space into an H classification with added controls. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-3-use-and-occupancy-classification#FLBC2023P2_Ch03_Sec307)
- **308 Institutional Group I** - Verify care/detention uses are correctly placed in the I subgroups. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-3-use-and-occupancy-classification#FLBC2023P2_Ch03_Sec308)
- **503 Height and Area Limitations** - Confirm allowable height/area for the occupancy and construction type before increases. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-5-general-building-heights-and-areas#FLBC2023P2_Ch05_Sec503)
- **504 Building Height and Number of Stories** - Verify actual height/stories, including sprinkler increases, stay within limits. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-5-general-building-heights-and-areas#FLBC2023P2_Ch05_Sec504)
- **506 Building Area** - Check area calculations including frontage and sprinkler increases and multistory factors. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-5-general-building-heights-and-areas#FLBC2023P2_Ch05_Sec506)
- **508 Mixed Use and Occupancy** - Verify separated/nonseparated occupancy approach and required separations are correct. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-5-general-building-heights-and-areas#FLBC2023P2_Ch05_Sec508)
- **509 Incidental Uses** - Confirm incidental use areas have the required separation or suppression. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-5-general-building-heights-and-areas#FLBC2023P2_Ch05_Sec509)
- **602 Construction Classification** - Verify the assigned Type I-V construction matches the fire-resistance ratings shown. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-6-types-of-construction#FLBC2023P2_Ch06_Sec602)
- **402 Covered/Open Mall Buildings** - For malls, check the special egress, separation, and suppression provisions. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-4-special-detailed-requirements-based-on-occupancy-and-use#FLBC2023P2_Ch04_Sec402)
- **403 High-Rise Buildings** - Verify high-rise fire command, standpipe, structural fire, and emergency power requirements. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-4-special-detailed-requirements-based-on-occupancy-and-use#FLBC2023P2_Ch04_Sec403)
- **404 Atriums / 406 Parking Garages** - Check atrium smoke control and parking-garage ventilation/opening criteria. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-4-special-detailed-requirements-based-on-occupancy-and-use#FLBC2023P2_Ch04_Sec404)

### Fire Protection & Life Safety
- **705 Exterior Walls** - Verify fire-resistance and opening limits based on fire separation distance. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-7-fire-and-smoke-protection-features#FLBC2023P2_Ch07_Sec705)
- **706 Fire Walls** - Check fire wall ratings, continuity, and structural independence where used to create separate buildings. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-7-fire-and-smoke-protection-features#FLBC2023P2_Ch07_Sec706)
- **707 Fire Barriers** - Verify fire barrier ratings for shafts, exits, and occupancy separations, including support continuity. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-7-fire-and-smoke-protection-features#FLBC2023P2_Ch07_Sec707)
- **708 Fire Partitions / 709 Smoke Barriers** - Confirm corridor, tenant, and smoke-compartment assemblies meet required ratings. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-7-fire-and-smoke-protection-features#FLBC2023P2_Ch07_Sec708)
- **713 Shaft Enclosures** - Check that vertical shafts are enclosed and rated with proper penetrations. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-7-fire-and-smoke-protection-features#FLBC2023P2_Ch07_Sec713)
- **716 Opening Protectives / 717 Dampers** - Verify door/window fire ratings and duct/damper protection at rated assemblies. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-7-fire-and-smoke-protection-features#FLBC2023P2_Ch07_Sec716)
- **903 Automatic Sprinkler Systems** - Confirm where sprinklers are required and that the specified NFPA 13 system suits the occupancy. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-9-fire-protection-systems#FLBC2023P2_Ch09_Sec903)
- **905 Standpipe Systems** - Check standpipe class, location, and hose connections for the building height/area. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-9-fire-protection-systems#FLBC2023P2_Ch09_Sec905)
- **907 Fire Alarm and Detection Systems** - Verify alarm, detection, and notification are provided where mandated. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-9-fire-protection-systems#FLBC2023P2_Ch09_Sec907)
- **909 Smoke Control Systems** - Where required (atriums, high-rise), confirm smoke-control design and rational analysis. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-9-fire-protection-systems#FLBC2023P2_Ch09_Sec909)
- **913 Fire Pumps** - Verify fire pump provisions where water supply is inadequate for demand. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-9-fire-protection-systems#FLBC2023P2_Ch09_Sec913)

### Egress
- **1004 Occupant Load** - Verify occupant load factors and posted occupant counts per space. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-10-means-of-egress#FLBC2023P2_Ch10_Sec1004)
- **1005 Egress Sizing** - Check that egress width (stairs and other components) meets calculated occupant load. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-10-means-of-egress#FLBC2023P2_Ch10_Sec1005)
- **1006 Number of Exits and Exit Access Doorways** - Confirm the minimum number of exits and separation for the occupant load. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-10-means-of-egress#FLBC2023P2_Ch10_Sec1006)
- **1009 Accessible Means of Egress** - Verify accessible egress, areas of refuge, and elevator/stair provisions. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-10-means-of-egress#FLBC2023P2_Ch10_Sec1009)
- **1010 Doors, Gates and Turnstiles** - Check egress door swing, hardware, panic hardware, and clear width. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-10-means-of-egress#FLBC2023P2_Ch10_Sec1010)
- **1011 Stairways** - Verify stair geometry, width, landings, and enclosure requirements. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-10-means-of-egress#FLBC2023P2_Ch10_Sec1011)
- **1017 Exit Access Travel Distance** - Confirm travel distances stay within limits for occupancy and sprinkler status. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-10-means-of-egress#FLBC2023P2_Ch10_Sec1017)
- **1020 Corridors** - Check corridor fire-resistance rating and minimum width for occupant load. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-10-means-of-egress#FLBC2023P2_Ch10_Sec1020)

### Accessibility
- **1103 Scoping Requirements** - Verify which buildings/elements must be accessible and applicable exceptions. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-11-accessibility#FLBC2023P2_Ch11_Sec1103)
- **1104 Accessible Route** - Confirm a continuous accessible route connects site arrival, entrances, and spaces. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-11-accessibility#FLBC2023P2_Ch11_Sec1104)
- **1106 Parking and Passenger Loading** - Check accessible parking counts, van spaces, and loading zones. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-11-accessibility#FLBC2023P2_Ch11_Sec1106)
- **1109 Other Features and Facilities** - Verify accessible toilet rooms, drinking fountains, signage, and similar elements. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-11-accessibility#FLBC2023P2_Ch11_Sec1109)

### Interior Environment
- **1203 Ventilation** - Confirm natural or mechanical ventilation is provided for occupied spaces. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-12-interior-environment#FLBC2023P2_Ch12_Sec1203)
- **1205 Lighting** - Verify required natural or artificial illumination for interior spaces and egress. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-12-interior-environment#FLBC2023P2_Ch12_Sec1205)
- **1207 Sound Transmission** - Check STC/IIC separation where required between dwelling/occupancy units. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-12-interior-environment#FLBC2023P2_Ch12_Sec1207)

### Exterior Envelope & Roofing
- **1403 Performance Requirements** - Verify exterior walls provide weather protection and required water-resistive barrier. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-14-exterior-walls#FLBC2023P2_Ch14_Sec1403)
- **1406 Combustible Materials on Exterior Walls** - Check limits on combustible cladding/trim by construction type. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-14-exterior-walls#FLBC2023P2_Ch14_Sec1406)
- **1407 Metal Composite Materials (MCM)** - Confirm MCM assemblies meet testing and installation limits. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-14-exterior-walls#FLBC2023P2_Ch14_Sec1407)
- **1504 Roof Performance Requirements** - Verify roof coverings resist wind uplift for the design wind speed. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-15-roof-assemblies-and-rooftop-structures#FLBC2023P2_Ch15_Sec1504)
- **1505 Fire Classification** - Check roof covering fire classification for the occupancy and construction type. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-15-roof-assemblies-and-rooftop-structures#FLBC2023P2_Ch15_Sec1505)
- **1507 Requirements for Roof Coverings** - Confirm the specific roof covering type meets its installation/attachment rules. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-15-roof-assemblies-and-rooftop-structures#FLBC2023P2_Ch15_Sec1507)

### Structural Design & Loads
- **1603 Construction Documents** - Verify structural drawings state all design loads, wind speed, exposure, risk category, and Florida product approval data. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-16-structural-design#FLBC2023P2_Ch16_Sec1603)
- **1604 General Design Requirements** - Check risk category, deflection limits, and overall structural design basis. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-16-structural-design#FLBC2023P2_Ch16_Sec1604)
- **1605 Load Combinations** - Confirm ASCE 7 load combinations are correctly applied. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-16-structural-design#FLBC2023P2_Ch16_Sec1605)
- **1607 Live Loads** - Verify occupancy live loads and reductions are correct. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-16-structural-design#FLBC2023P2_Ch16_Sec1607)
- **1609 Wind Loads** - Verify ultimate design wind speed from the FBC maps, exposure category, wind-borne debris region, and required opening/glazing protection. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-16-structural-design#FLBC2023P2_Ch16_Sec1609)
- **1612 Flood Loads** - Confirm flood loads and design flood elevation for structures in flood hazard areas. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-16-structural-design#FLBC2023P2_Ch16_Sec1612)
- **1613 Earthquake Loads** - Check seismic design parameters (limited in most of Florida but required to be addressed). [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-16-structural-design#FLBC2023P2_Ch16_Sec1613)
- **1615 Structural Integrity** - Verify disproportionate-collapse provisions where applicable to high-rise/high-occupancy. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-16-structural-design#FLBC2023P2_Ch16_Sec1615)
- **2404 Wind and Dead Loads on Glass** - Confirm glass is designed for the design wind pressure. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-24-glass-and-glazing#FLBC2023P2_Ch24_Sec2404)
- **2406 Safety Glazing** - Verify safety glazing in hazardous locations (doors, low glazing, wet areas). [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-24-glass-and-glazing#FLBC2023P2_Ch24_Sec2406)

### HVHZ (High-Velocity Hurricane Zone)
- **1616 HVHZ - General/Deflection** - In Miami-Dade/Broward, verify structural general and deflection provisions per HVHZ rules. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-16-structural-design#FLBC2023P2_Ch16_Sec1616)
- **1620 HVHZ - Wind Loads** - Confirm HVHZ-specific wind load determination is used within the zone. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-16-structural-design#FLBC2023P2_Ch16_Sec1620)
- **1621 HVHZ - Overturning Moment and Uplift** - Check uplift and overturning resistance for HVHZ structures. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-16-structural-design#FLBC2023P2_Ch16_Sec1621)
- **1622 HVHZ - Screen Enclosures** - Verify screen enclosure design against HVHZ criteria. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-16-structural-design#FLBC2023P2_Ch16_Sec1622)
- **1626 HVHZ - Impact Tests for Wind-Borne Debris** - Confirm opening protection has passed the required large/small missile impact tests. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-16-structural-design#FLBC2023P2_Ch16_Sec1626)
- **1512 HVHZ - Roofing General** - Verify HVHZ roof assemblies meet the zone's added weather/uplift requirements. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-15-roof-assemblies-and-rooftop-structures#FLBC2023P2_Ch15_Sec1512)
- **1817 HVHZ - Foundation Excavations** - Check HVHZ foundation and excavation provisions in the zone. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-18-soils-and-foundations#FLBC2023P2_Ch18_Sec1817)
- **1919 HVHZ - Concrete / 2118 HVHZ - Masonry / 2214 HVHZ - Steel / 2314 HVHZ - Wood** - Verify each material chapter's HVHZ section governs design/QA within the zone. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-19-concrete#FLBC2023P2_Ch19_Sec1919)
- **2410 HVHZ - Glass/Glazing** - Confirm HVHZ glazing and impact-protection provisions for openings. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-24-glass-and-glazing#FLBC2023P2_Ch24_Sec2410)

### Foundations & Materials
- **1803 Geotechnical Investigations** - Verify a soils/geotechnical report supports the foundation design where required. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-18-soils-and-foundations#FLBC2023P2_Ch18_Sec1803)
- **1808 Foundations** - Check general foundation design, depth, and bearing provisions. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-18-soils-and-foundations#FLBC2023P2_Ch18_Sec1808)
- **1810 Deep Foundations** - Verify pile/pier design, capacity, and installation criteria. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-18-soils-and-foundations#FLBC2023P2_Ch18_Sec1810)
- **1816 Termite Protection** - Confirm required termite protection method is specified. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-18-soils-and-foundations#FLBC2023P2_Ch18_Sec1816)
- **1905 Modifications to ACI 318 (Concrete)** - Check Florida amendments to ACI 318 are applied. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-19-concrete#FLBC2023P2_Ch19_Sec1905)
- **1909 Special Wind Provisions for Concrete** - Verify prescriptive concrete wind provisions where used. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-19-concrete#FLBC2023P2_Ch19_Sec1909)
- **2105 Masonry Quality Assurance / 2115 Special Wind Provisions** - Confirm masonry QA level and wind provisions. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-21-masonry#FLBC2023P2_Ch21_Sec2105)
- **2114 Masonry Termite Inspection** - Verify termite inspection gap/clearance at masonry per Florida rules. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-21-masonry#FLBC2023P2_Ch21_Sec2114)
- **2205 Structural Steel / 2210 Cold-Formed Steel** - Check steel design standards and detailing references. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-22-steel#FLBC2023P2_Ch22_Sec2205)
- **2304 Wood General Construction / 2308 Conventional Light-Frame** - Verify wood member sizing, connections, and bracing. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-23-wood#FLBC2023P2_Ch23_Sec2304)
- **2002/2003 Aluminum** - Check aluminum design and HVHZ aluminum provisions for structures/enclosures. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-20-aluminum#FLBC2023P2_Ch20_Sec2002)

### Inspections & Tests
- **1703 Approvals** - Verify approved agencies, testing labs, and product evaluation reports (Florida Product Approval / Miami-Dade NOA). [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-17-special-inspections-and-tests#FLBC2023P2_Ch17_Sec1703)
- **1704 Special Inspections, Contractor Responsibility, Structural Observation** - Confirm a statement of special inspections and threshold-building inspection plan is provided and sealed. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-17-special-inspections-and-tests#FLBC2023P2_Ch17_Sec1704)
- **1705 Required Special Inspections and Tests** - Verify the specific special inspections (concrete, steel, soils, wind/seismic resistance) match the scope. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-17-special-inspections-and-tests#FLBC2023P2_Ch17_Sec1705)

### Flood
- **Appendix G Flood-Resistant Construction** - Where adopted, verify flood-hazard design, elevation, and enclosure/venting provisions. [Link](https://codes.iccsafe.org/content/FLBC2023P2/appendix-g-flood-resistant-construction#FLBC2023P2_AppxG)
- **1612 Flood Loads (cross-ref)** - Confirm structures in SFHAs address flood loads and DFE. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-16-structural-design#FLBC2023P2_Ch16_Sec1612)

### Misc
- **3002 Elevator Hoistway Enclosures / 3007 Fire Service Access Elevator** - Verify hoistway enclosure ratings and, in high-rise, fire service access elevators. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-30-elevators-and-conveying-systems#FLBC2023P2_Ch30_Sec3007)
- **3105 Awnings and Canopies / 3109 Coastal Construction** - Check awning/canopy design and structures seaward of the coastal construction control line. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-31-special-construction#FLBC2023P2_Ch31_Sec3109)
- **3111 Solar Energy Systems** - Verify rooftop solar attachment and wind design. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-31-special-construction#FLBC2023P2_Ch31_Sec3111)
- **3306 Protection of Pedestrians / 3307 Protection of Adjoining Property** - Confirm site safety and adjacent-property protection during construction. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-33-safeguards-during-construction#FLBC2023P2_Ch33_Sec3306)
- **3312 Automatic Sprinkler During Construction** - Verify sprinkler/standpipe availability during construction of tall buildings. [Link](https://codes.iccsafe.org/content/FLBC2023P2/chapter-33-safeguards-during-construction#FLBC2023P2_Ch33_Sec3312)

#### Coverage notes
- All chapter slugs and every section anchor above were verified against the live rendered pages (zero-padded/SubCh anchors like `Ch01_SubCh02_Sec105` confirmed). Bad slugs redirect to the volume root, so the slugs used here are confirmed distinct.
- Appendix G is linked at the appendix anchor level (`FLBC2023P2_AppxG`) only; individual G-section anchors are lazy-loaded and were not independently verified.
- Chapters 4, 15, and the materials chapters contain additional HVHZ and detailed subsections beyond those cited; only reviewer-relevant top-level sections were included. Dotted subsection anchors (e.g., 1609.3, 1704.x threshold-building details) exist but were not emitted individually.
## FBC Residential - 2023 8th Edition
Base: [2023 FBC Residential](https://codes.iccsafe.org/content/FLRC2023P2) - 1- & 2-family dwellings and townhouses (not more than 3 stories). Effective Dec 31, 2023; amends the 2021 IRC. Deep links point to verified section anchors.

### Scope & Administration
- **R101 Scope & general requirements** - Confirm the project is a detached/attached 1-2 family dwelling or townhouse ≤3 stories with separate egress; anything outside that scope falls under the Building code. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-1-scope-and-administration#FLRC2023P2_Pt01_Ch01_SubCh01_SecR101)
- **R104 Duties & powers of the building official** - Check that alternatives, modifications, and interpretations are documented and approved by the building official. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-1-scope-and-administration#FLRC2023P2_Pt01_Ch01_SubCh02_SecR104)
- **R105 Permits** - Verify a permit is required for the scope and that no exempt/expired condition is being misapplied. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-1-scope-and-administration#FLRC2023P2_Pt01_Ch01_SubCh02_SecR105)
- **R106 Construction documents** - Confirm plans are complete, dimensioned, site-specific, and show wind/flood design data, signed/sealed where required. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-1-scope-and-administration#FLRC2023P2_Pt01_Ch01_SubCh02_SecR106)
- **R109 Inspections** - Confirm required inspection stages (foundation, framing, etc.) are called out and coordinated. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-1-scope-and-administration#FLRC2023P2_Pt01_Ch01_SubCh02_SecR109)
- **R110 Certificate of occupancy** - Verify prerequisites for issuance of the CO are addressed on the plans. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-1-scope-and-administration#FLRC2023P2_Pt01_Ch01_SubCh02_SecR110)
- **Ch. 2 Definitions** - Use for defined terms (e.g., townhouse, habitable space, grade plane) that drive code applicability. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-2-definitions)

### Design Criteria & Wind
- **R301 Design criteria** - Confirm the structure is designed for all dead, live, roof, flood, and wind loads via prescriptive or engineered methods. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR301)
- **R301.2 Climatic & geographic design criteria** - Check the plan lists the jurisdiction-specific values (wind speed, exposure, flood, termite, seismic) from Table R301.2(1). [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR301.2)
- **R301.2.1 Wind design criteria** - Verify wind design uses the correct ultimate design wind speed (Vult) and exposure category for the site. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR301.2.1)
- **R301.2.1.1 Wind design required** - Where Vult from Figure R301.2(4) is ≥115 mph, confirm an approved engineered/prescriptive wind method (WFCM, ICC-600, AISI, TMS, or Ch. 16 of the Building code) is used. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR301.2.1.1)

### Fire & Life Safety
- **R302 Fire-resistant construction** - Check exterior wall fire ratings and projection limits by fire separation distance to lot lines. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR302)
- **R302.1 Exterior walls** - Verify rated wall assemblies/opening limits where fire separation distance is under the threshold. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR302.1)
- **R302.5 Dwelling-garage separation** - Confirm the required opening protection and separation between an attached garage and the dwelling. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR302.5)
- **R302.13 Fire protection of floors** - Check membrane/floor-assembly protection at floors over usable space where required. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR302.13)
- **R313 Automatic fire sprinkler systems** - Confirm whether a residential sprinkler system is required/provided and designed to the referenced standard. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR313)
- **R314 Smoke alarms** - Verify smoke alarm locations (each bedroom, outside sleeping areas, each level), interconnection, and power source. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR314)
- **R315 Carbon monoxide alarms** - Confirm CO alarms where fuel-fired appliances or attached garages are present. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR315)
- **R317 Protection of wood against decay** - Check that wood in contact with concrete/ground/weather is naturally durable or preservative-treated. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR317)

### Egress & Openings
- **R303 Light, ventilation & heating** - Verify each habitable room meets minimum glazing/openable-area (or mechanical equivalent) and heating. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR303)
- **R308 Glazing** - Confirm safety (tempered/laminated) glazing at hazardous locations such as doors, tubs, and stairs. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR308)
- **R309 Garages & carports** - Check floor slope/materials, and separation of garage from dwelling. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR309)
- **R310 Emergency escape & rescue openings** - Verify each sleeping room and basement has a compliant EERO (min clear opening, sill height, well access). [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR310)
- **R311 Means of egress** - Confirm egress door, hallway widths, stairway geometry (riser/tread), landings, and ramp requirements. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR311)
- **R312 Guards & window fall protection** - Check guard height/opening limits at raised walking surfaces and window fall protection at bedrooms. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR312)

### Flood & Termite
- **R318 Protection against termites** - Verify an approved termite treatment/method is specified for this termite-infestation-probability area. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR318)
- **R318.4 Concrete bearing ledge** - Check the required foundation bearing-ledge detail where exterior veneer/foam is used, per Florida amendment. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR318.4)
- **R322 Flood-resistant construction** - Confirm design freeboard, flood-damage-resistant materials, and lowest-floor/enclosure requirements for the flood zone. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR322)
- **R322.2 Flood hazard areas (A Zones)** - Verify lowest floor elevation and flood-opening/venting for enclosures below the design flood elevation. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR322.2)
- **R322.3 Coastal high-hazard areas (V Zones/Coastal A)** - Check open pile/column foundation, breakaway walls, and lowest-horizontal-member elevation. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-3-building-planning#FLRC2023P2_Pt03_Ch03_SecR322.3)

### Foundations
- **R401 General** - Confirm foundation is designed for site soils, drainage, and grade; geotechnical data where required. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-4-foundations#FLRC2023P2_Pt03_Ch04_SecR401)
- **R403 Footings** - Verify footing size, depth, and reinforcement for imposed loads and soil bearing. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-4-foundations#FLRC2023P2_Pt03_Ch04_SecR403)
- **R404 Foundation & retaining walls** - Check concrete/masonry wall thickness, reinforcement, and lateral-support design. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-4-foundations#FLRC2023P2_Pt03_Ch04_SecR404)
- **R405 Foundation drainage** - Confirm drainage provisions around footings/foundation walls where required. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-4-foundations#FLRC2023P2_Pt03_Ch04_SecR405)
- **R406 Foundation waterproofing/dampproofing** - Verify dampproofing or waterproofing at below-grade walls. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-4-foundations#FLRC2023P2_Pt03_Ch04_SecR406)
- **R408 Under-floor space** - Check crawlspace ventilation, access, and grading. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-4-foundations#FLRC2023P2_Pt03_Ch04_SecR408)

### Wall & Roof Construction
- **R502 Wood floor framing** - Verify joist spans, bearing, notching/boring, and connections against the span tables. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-5-floors#FLRC2023P2_Pt03_Ch05_SecR502)
- **R507 Exterior decks** - Confirm deck ledger attachment, footings, guards, and lateral load connections. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-5-floors#FLRC2023P2_Pt03_Ch05_SecR507)
- **R602 Wood wall framing** - Check stud size/spacing/height, headers, bracing, and wall-bracing method for wind. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-6-wall-construction#FLRC2023P2_Pt03_Ch06_SecR602)
- **R606 General masonry construction** - Verify masonry wall thickness, reinforcement, lateral support, and anchorage. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-6-wall-construction#FLRC2023P2_Pt03_Ch06_SecR606)
- **R608 Exterior concrete wall construction** - Confirm concrete (incl. ICF) wall design and reinforcement. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-6-wall-construction#FLRC2023P2_Pt03_Ch06_SecR608)
- **R609 Exterior windows & doors** - Verify fenestration meets design pressure (DP) rating, testing/labeling, and anchorage for the site wind load. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-6-wall-construction#FLRC2023P2_Pt03_Ch06_SecR609)
- **R609.4 Garage doors** - Confirm garage doors are rated/labeled for the design wind pressure. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-6-wall-construction#FLRC2023P2_Pt03_Ch06_SecR609.4)
- **R609.6 Wind-borne debris protection** - Check impact protection (rated glazing or shutters) for openings in wind-borne debris regions. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-6-wall-construction#FLRC2023P2_Pt03_Ch06_SecR609.6)
- **R703 Exterior covering** - Verify siding/veneer type, attachment, water-resistive barrier, and flashing. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-7-wall-covering#FLRC2023P2_Pt03_Ch07_SecR703)
- **R802 Wood roof framing** - Check rafter/truss spans, bracing, and connections; truss drawings where applicable. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-8-roof-ceiling-construction#FLRC2023P2_Pt03_Ch08_SecR802)
- **R806 Roof ventilation** - Confirm attic/rafter ventilation ratios or approved unvented assembly. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-8-roof-ceiling-construction#FLRC2023P2_Pt03_Ch08_SecR806)

### Roofing
- **R902 Fire classification** - Verify roof covering fire class where required. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-9-roof-assemblies#FLRC2023P2_Pt03_Ch09_SecR902)
- **R903 Weather protection** - Check flashing, drainage, and secondary water barrier provisions. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-9-roof-assemblies#FLRC2023P2_Pt03_Ch09_SecR903)
- **R905 Requirements for roof coverings** - Confirm each covering type (shingle, tile, metal) meets fastening/wind-resistance for the design wind speed. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-9-roof-assemblies#FLRC2023P2_Pt03_Ch09_SecR905)
- **R907 Rooftop PV systems** - Verify structural and wind attachment of rooftop photovoltaic systems. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-9-roof-assemblies#FLRC2023P2_Pt03_Ch09_SecR907)
- **R1001/R1003 Masonry fireplaces & chimneys** - Check firebox/hearth clearances and chimney height/termination where a masonry fireplace is used. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-10-chimneys-and-fireplaces#FLRC2023P2_Pt03_Ch10_SecR1001)

### Energy
- **N1101 Energy efficiency (Ch. 11 [RE])** - Confirm energy compliance is demonstrated per the Florida Building Code, Energy Conservation (this chapter defers to that code). [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-11-re-energy-efficiency#FLRC2023P2_Pt04_Ch11_SecN1101)

### Florida-Specific / Product Approval
- **Product approval & DP labeling (R609.3 / R609.4.1)** - Verify windows, doors, and garage doors carry required test labels / Florida Product Approval or Miami-Dade NOA for the design pressure. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-6-wall-construction#FLRC2023P2_Pt03_Ch06_SecR609)
- **Opening / wind-borne debris protection (R609.6)** - In wind-borne debris regions (much of coastal FL), confirm impact-rated openings or code-compliant shutter protection. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-6-wall-construction#FLRC2023P2_Pt03_Ch06_SecR609.6)
- **High-Velocity Hurricane Zone (HVHZ)** - For Miami-Dade/Broward, confirm HVHZ-specific provisions apply; this volume carries a dedicated HVHZ electrical chapter (Ch. 44). [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-44-high-velocity-hurricane-zones)

### Trade Parts (M/G/P/E)
- **Mechanical (Part V, Ch. 12-23)** - Confirm HVAC equipment sizing, duct systems, combustion air, and exhaust meet the residential mechanical provisions. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-13-general-mechanical-system-requirements)
- **Fuel Gas (Part VI, Ch. 24)** - Verify gas piping sizing, appliance connections, and venting where fuel gas is present. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-24-fuel-gas)
- **Plumbing (Part VII, Ch. 25-33)** - Check fixtures, water supply/distribution sizing, sanitary drainage, venting, and traps. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-25-plumbing-administration)
- **Electrical (Part VIII, Ch. 34-45)** - Verify services, branch circuits, wiring methods, GFCI/AFCI, and pool electrical provisions. [Link](https://codes.iccsafe.org/content/FLRC2023P2/chapter-34-general-requirements)

#### Coverage notes
- All chapter slugs (1-11, 13, 24, 25, 34, 44) were confirmed with HTTP 200; all Chapter 1-10 section anchors were observed live in the DOM. Chapter 3, 6, and 11 subsection anchors (R301.2.x, R302.x, R318.4, R322.x, R609.x, N1101) were verified by element id.
- Anchor ids for Chapters 4-10 follow the verified DOM pattern `FLRC2023P2_Pt03_Ch0N_SecRxxx` (Part 03) and for Ch. 11 `Pt04_Ch11_SecN1101`; Chapter 1 uses a `SubCh` segment (`Pt01_Ch01_SubCh0N_SecRxxx`) as observed. Section-level (Rxxx) anchors for Ch. 4-10 and 1 were directly observed; the composite deep-link fragments were assembled from those verified ids and the verified chapter URLs.
- HVHZ: detailed HVHZ structural requirements live in the FBC Building volume, not this Residential volume.
- Trade-part bullets are intentionally chapter-level pointers only per scope.
## FBC Existing Building - 2023 8th Edition
Base: [2023 FBC Existing Building](https://codes.iccsafe.org/content/FLEBC2023P2)

### Scope, Applicability & Compliance Method Selection
- **301.1 General scope** - Confirm the project falls under the Existing Building code (repair, alteration, change of occupancy, addition, relocation of existing buildings). [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-3-provisions-for-all-compliance-methods#FLEBC2023P2_Ch03_Sec301.1)
- **301.3 Compliance path election** - Verify the applicant chose and consistently applied ONE method (prescriptive, work-area, or performance) for alteration/change of occupancy/addition/relocation work. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-3-provisions-for-all-compliance-methods#FLEBC2023P2_Ch03_Sec301.3)
- **301.3.1 Prescriptive method** - Prescriptive route sends the reviewer to Chapter 5 for the whole project. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-3-provisions-for-all-compliance-methods#FLEBC2023P2_Ch03_Sec301.3.1)
- **301.3.2 Work-area method** - Work-area route sends the reviewer to Chapters 6-13 (classification then level-specific chapters). [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-3-provisions-for-all-compliance-methods#FLEBC2023P2_Ch03_Sec301.3.2)
- **301.3.3 Performance method** - Performance route sends the reviewer to Chapter 14 (compliance scoring). [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-3-provisions-for-all-compliance-methods#FLEBC2023P2_Ch03_Sec301.3.3)
- **1401 Performance compliance** - Check the compliance-evaluation scoring calculation when the performance method is used. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-14-performance-compliance-methods#FLEBC2023P2_Ch14_Sec1401)

### Repairs (Chapter 4)
- **401.1 Repair scope** - Confirm the work is truly a repair (restoration to predamage/working condition) versus an alteration triggering higher requirements. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-4-repairs#FLEBC2023P2_Ch04_Sec401.1)
- **406.2 Repairs to damaged buildings** - Check whether damage rises to "substantial structural damage," which drives the required extent of structural repair. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-4-repairs#FLEBC2023P2_Ch04_Sec406.2)
- **406.2.2 Substantial damage to lateral-force-resisting elements** - Requires evaluation and, for noncompliant buildings, repair/upgrade of the wind/seismic system. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-4-repairs#FLEBC2023P2_Ch04_Sec406.2.2)
- **406.2.3 Substantial damage to gravity load-carrying components** - Damaged gravity members must be restored to pre-damage capacity or better. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-4-repairs#FLEBC2023P2_Ch04_Sec406.2.3)

### Classification of Work / Alteration Levels (Chapter 6)
- **602 / 603 / 604 Alteration Levels 1, 2, 3** - Verify the work is correctly classified: Level 1 (materials/replacement), Level 2 (reconfiguration/space), Level 3 (work area over 50% of building area). [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-6-classification-of-work#FLEBC2023P2_Ch06_Sec602)
- **605 / 606 / 607 / 608 Change of occupancy, additions, historic, relocated** - Confirm the correct work category is assigned, since each routes to its own chapter. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-6-classification-of-work#FLEBC2023P2_Ch06_Sec605)

### Structural Provisions for Alterations
- **807.4 / 807.5 Level 2 gravity & lateral elements** - Check load-increase thresholds (e.g., >5% gravity, wind/seismic demand triggers) that force existing members to be brought into compliance. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-8-alterations-level-2#FLEBC2023P2_Ch08_Sec807.5)
- **807.6 Voluntary lateral system alterations** - Verify voluntary strengthening does not reduce the strength/stiffness of the existing lateral system. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-8-alterations-level-2#FLEBC2023P2_Ch08_Sec807.6)
- **907 Level 3 structural** - Level 3 work applies the Level 2 structural provisions to the whole building's work area. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-9-alterations-level-3#FLEBC2023P2_Ch09_Sec907)

### Florida Roofing / Reroofing (Chapter 7, Sec. 706)
- **706.1.1 25% roof rule** - No more than 25% of a roof area/section may be repaired, replaced, or recovered in any 12-month period unless the entire roof section is brought into code compliance. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-7-alterations-level-1#FLEBC2023P2_Ch07_Sec706.1.1)
- **706.3 Recovering versus replacement** - Confirm existing coverings are torn off (no recover) where the deck is water-soaked, deteriorated, or already has the maximum layers. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-7-alterations-level-1#FLEBC2023P2_Ch07_Sec706.3)
- **706.4 Roof recovering** - Check that recover (over existing) is permitted for this assembly and meets the listed conditions. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-7-alterations-level-1#FLEBC2023P2_Ch07_Sec706.4)

### Change of Occupancy, Additions, Historic, Relocated
- **1012 Change of occupancy classification** - Verify hazard-category analysis and the resulting fire/egress/structural upgrades triggered by the new use. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-10-change-of-occupancy#FLEBC2023P2_Ch10_Sec1012)
- **1103 Additions - structural** - New additions must meet new-building loads, and the existing structure supporting the addition must be checked for overload. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-11-additions#FLEBC2023P2_Ch11_Sec1103)
- **1205 Historic buildings compliance** - Confirm the historic designation and that reduced/alternative compliance is justified without creating a distinct life-safety hazard. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-12-historic-buildings#FLEBC2023P2_Ch12_Sec1205)
- **1302 Relocated/moved buildings - requirements** - Check that the moved building is sited and re-anchored to meet current wind/flood and foundation provisions. [Link](https://codes.iccsafe.org/content/FLEBC2023P2/chapter-13-relocated-or-moved-buildings#FLEBC2023P2_Ch13_Sec1302)

## FBC Energy Conservation - 2023 8th Edition
Base: [2023 FBC Energy Conservation](https://codes.iccsafe.org/content/FLEC2023P1)

### [CE] Commercial Provisions
- **C401.2 Compliance paths** - Confirm one of three routes: ANSI/ASHRAE/IESNA 90.1; prescriptive (C402-C406 + C408); or performance (C407, <=85% of reference building). [Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-4-ce-commercial-energy-efficiency#FLEC2023P1_CE_Ch04_SecC401.2)
- **C402.1-C402.2 Building envelope / insulation** - Check opaque envelope U-factors/R-values against the prescriptive tables for the climate zone. [Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-4-ce-commercial-energy-efficiency#FLEC2023P1_CE_Ch04_SecC402.2)
- **C402.4 Fenestration** - Verify window/skylight area limits and U-factor / SHGC values. [Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-4-ce-commercial-energy-efficiency#FLEC2023P1_CE_Ch04_SecC402.4)
- **C402.5 Air leakage (Mandatory)** - Check the continuous air barrier and sealing/testing requirements. [Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-4-ce-commercial-energy-efficiency#FLEC2023P1_CE_Ch04_SecC402.5)
- **C403 Building mechanical systems** - Verify HVAC equipment efficiency, economizers, and controls. [Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-4-ce-commercial-energy-efficiency#FLEC2023P1_CE_Ch04_SecC403)
- **C404 Service water heating (Mandatory)** - Check water-heater efficiency and pipe insulation. [Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-4-ce-commercial-energy-efficiency#FLEC2023P1_CE_Ch04_SecC404)
- **C405 Electrical power & lighting** - Verify interior/exterior lighting power allowances and mandatory lighting controls. [Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-4-ce-commercial-energy-efficiency#FLEC2023P1_CE_Ch04_SecC405)
- **C407 Total building performance** - Check the whole-building energy-cost model when the performance path is used. [Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-4-ce-commercial-energy-efficiency#FLEC2023P1_CE_Ch04_SecC407)

### [RE] Residential Provisions
- **R401.2 Compliance paths** - Confirm one of three routes: prescriptive (R401-R404); simulated performance (R405); or Energy Rating Index (R406). [Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-4-re-residential-energy-efficiency#FLEC2023P1_RE_Ch04_SecR401.2)
- **R402.2 Insulation requirements** - Check ceiling/wall/floor/slab R-values against the prescriptive table. [Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-4-re-residential-energy-efficiency#FLEC2023P1_RE_Ch04_SecR402.2)
- **R402.3 Fenestration** - Verify window U-factor and SHGC limits. [Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-4-re-residential-energy-efficiency#FLEC2023P1_RE_Ch04_SecR402.3)
- **R402.4 Air leakage (Mandatory)** - Check building-envelope tightness and required blower-door test result. [Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-4-re-residential-energy-efficiency#FLEC2023P1_RE_Ch04_SecR402.4)
- **R403.3 / R403.5 / R403.6 Ducts, service hot water, ventilation** - Verify duct sealing/testing, hot-water pipe insulation, and mechanical ventilation. [Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-4-re-residential-energy-efficiency#FLEC2023P1_RE_Ch04_SecR403.3)
- **R404 Electrical power & lighting** - Check the required percentage of high-efficacy lighting. [Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-4-re-residential-energy-efficiency#FLEC2023P1_RE_Ch04_SecR404)
- **R405 Simulated performance alternative** - Review the modeled proposed-vs-standard energy-cost comparison. [Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-4-re-residential-energy-efficiency#FLEC2023P1_RE_Ch04_SecR405)
- **R406 Energy Rating Index** - Verify the ERI score meets the required target with the mandatory backstops. [Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-4-re-residential-energy-efficiency#FLEC2023P1_RE_Ch04_SecR406)
- **Ch. 5 [CE] & [RE] Existing buildings** - For additions/alterations/change of occupancy to existing buildings, apply the existing-building energy chapters. [CE Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-5-ce-existing-buildings) / [RE Link](https://codes.iccsafe.org/content/FLEC2023P1/chapter-5-re-existing-buildings)

## FBC Accessibility - 2023 8th Edition
Base: [2023 FBC Accessibility](https://codes.iccsafe.org/content/FLAC2023P1)

### Scoping & Florida-Specific Provisions (Chapter 2)
- **201.1.1 Vertical accessibility (Florida)** - Florida requires accessibility to all occupiable levels above/below grade (per F.S. 553.501-553.513) even where the ADA Standards would not mandate an elevator; check the limited mechanical-space exceptions. [Link](https://codes.iccsafe.org/content/FLAC2023P1/chapter-2-scoping-requirements#FLAC2023P1_Ch02_Sec201.1.1)
- **201.2 Application based on building/facility use** - Confirm scoping is applied per the specific occupancy/use category. [Link](https://codes.iccsafe.org/content/FLAC2023P1/chapter-2-scoping-requirements#FLAC2023P1_Ch02_Sec201.2)
- **202 Existing buildings (additions/alterations)** - Check 202.2 additions, 202.3 alterations, and 202.4 primary-function-area path-of-travel upgrade obligations. [Link](https://codes.iccsafe.org/content/FLAC2023P1/chapter-2-scoping-requirements#FLAC2023P1_Ch02_Sec202)
- **203 General exceptions** - Verify any claimed scoping exceptions (limited-access spaces, machinery spaces, etc.) actually apply. [Link](https://codes.iccsafe.org/content/FLAC2023P1/chapter-2-scoping-requirements#FLAC2023P1_Ch02_Sec203)
- **206 Accessible routes** - Confirm at least one accessible route connects site arrival points, and check 206.4 entrances scoping. [Link](https://codes.iccsafe.org/content/FLAC2023P1/chapter-2-scoping-requirements#FLAC2023P1_Ch02_Sec206)
- **207 Accessible means of egress** - Verify the number of accessible egress routes and areas of refuge. [Link](https://codes.iccsafe.org/content/FLAC2023P1/chapter-2-scoping-requirements#FLAC2023P1_Ch02_Sec207)
- **208 Parking spaces (Florida)** - Check accessible parking counts per the Florida table, and cross-check 502.5 for van parking in structures. [Link](https://codes.iccsafe.org/content/FLAC2023P1/chapter-2-scoping-requirements#FLAC2023P1_Ch02_Sec208)
- **213 Toilet & bathing facilities** - Verify each provided toilet/bathing room and the required accessible fixtures/accessories comply. [Link](https://codes.iccsafe.org/content/FLAC2023P1/chapter-2-scoping-requirements#FLAC2023P1_Ch02_Sec213)
- **224 Transient lodging guest rooms** - Check the required number of accessible and communication-feature guest rooms. [Link](https://codes.iccsafe.org/content/FLAC2023P1/chapter-2-scoping-requirements#FLAC2023P1_Ch02_Sec224)
- **233 Residential facilities / dwelling units** - Verify the scoped count of accessible (Type A/B-equivalent) dwelling units for multifamily/covered residential, distinguishing HUD vs non-HUD entities (233.2-233.6). [Link](https://codes.iccsafe.org/content/FLAC2023P1/chapter-2-scoping-requirements#FLAC2023P1_Ch02_Sec233)

### Technical Criteria (referenced from scoping)
- **Ch. 3 Building blocks** - Technical baseline (clear floor space, reach ranges, turning space) used to judge every element. [Link](https://codes.iccsafe.org/content/FLAC2023P1/chapter-3-building-blocks)
- **Ch. 4 Accessible routes** - Detailed route technical requirements (walking surfaces, doors, ramps, elevators, lifts). [Link](https://codes.iccsafe.org/content/FLAC2023P1/chapter-4-accessible-routes)
- **Ch. 5 General site & building elements** - Parking space, passenger loading, and stairway technical criteria (incl. 502.5 van spaces). [Link](https://codes.iccsafe.org/content/FLAC2023P1/chapter-5-general-site-and-building-elements)
- **Ch. 6 Plumbing elements & facilities** - Technical criteria for accessible toilet rooms, lavatories, and fixtures. [Link](https://codes.iccsafe.org/content/FLAC2023P1/chapter-6-plumbing-elements-and-facilities)

#### Coverage notes
- All chapter slugs above were confirmed by same-origin fetch returning HTTP 200; every section anchor id was observed directly in the rendered DOM.
- Existing Building Chapters 1, 2, 15-17 and appendices, and the full text of Level 1 (Ch. 7) non-structural sections, were not detailed here as they fall outside the core plan-review triggers.
- Energy Chapter 5 (existing buildings) for both [CE] and [RE] tracks is linked at chapter-root level only; individual section anchors within those chapters were not enumerated.
- Accessibility Chapters 3-6 are linked at chapter-root level as technical-criteria references; only Chapter 2 scoping anchors were individually verified.
- The Florida accessibility code incorporates F.S. 553 and is based on the 2010 ADA Standards, as reflected in Section 201.1.1.
## FBC Mechanical - 2023 8th Edition
Base: [2023 FBC Mechanical](https://codes.iccsafe.org/content/FLMC2023P2)

### Administration
- **101/102 Scope & Applicability** - Confirm the project's mechanical work falls under this volume (commercial and R-2/R-3/R-4 over three stories) and not the Residential volume. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-1-scope-and-administration#FLMC2023P2_Ch01_SubCh01_Sec101)
- **106 Permits** - Verify required construction documents, equipment schedules, and load calcs are submitted before permitting. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-1-scope-and-administration#FLMC2023P2_Ch01_SubCh02_Sec106)
- **107 Inspections & Testing** - Check that required inspections and system tests are identified for the scope of work. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-1-scope-and-administration#FLMC2023P2_Ch01_SubCh02_Sec107)

### General Regulations (Ch 3)
- **303 Equipment & Appliance Location** - Confirm equipment is located per allowed locations (attics, under floors, outdoors, hazardous areas) with required protections. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-3-general-regulations#FLMC2023P2_Ch03_Sec303)
- **304 Installation** - Check clearances to combustibles, elevation above grade/flood, and required equipment platforms/anchorage (Florida wind/flood context for rooftop and exterior units). [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-3-general-regulations#FLMC2023P2_Ch03_Sec304)
- **306 Access & Service Space** - Verify service access, working clearances, and attic/under-floor access openings and passageways to appliances. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-3-general-regulations#FLMC2023P2_Ch03_Sec306)
- **307 Condensate Disposal** - Confirm primary and secondary (auxiliary) condensate drainage, pan/switch provisions, and approved discharge points. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-3-general-regulations#FLMC2023P2_Ch03_Sec307)
- **312 Heating & Cooling Load Calculations** - Verify equipment sizing is supported by load calculations per approved methods. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-3-general-regulations#FLMC2023P2_Ch03_Sec312)

### Ventilation (Ch 4)
- **403 Mechanical Ventilation** - Check outdoor air rates by occupancy/area against required ventilation, plus outdoor intake and exhaust separation. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-4-ventilation#FLMC2023P2_Ch04_Sec403)
- **404 Enclosed Parking Garages** - Verify garage exhaust rates and contaminant (CO) control provisions. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-4-ventilation#FLMC2023P2_Ch04_Sec404)

### Exhaust Systems (Ch 5)
- **504 Clothes Dryer Exhaust** - Check duct material, termination, max developed length, and makeup air for dryers. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-5-exhaust-systems#FLMC2023P2_Ch05_Sec504)
- **506/507 Commercial Kitchen Hoods & Ventilation** - Verify Type I/II hood construction, duct listing/clearances, and grease duct routing. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-5-exhaust-systems#FLMC2023P2_Ch05_Sec507)
- **508 Commercial Kitchen Makeup Air** - Confirm makeup air quantity and interlock with the exhaust system. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-5-exhaust-systems#FLMC2023P2_Ch05_Sec508)
- **510 Hazardous Exhaust Systems** - Check separate hazardous exhaust design, materials, and discharge for labs/hazardous processes. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-5-exhaust-systems#FLMC2023P2_Ch05_Sec510)

### Duct Systems (Ch 6)
- **602 Plenums** - Verify materials and combustibles allowed in return-air/ceiling plenums. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-6-duct-systems#FLMC2023P2_Ch06_Sec602)
- **603 Duct Construction & Installation** - Check duct gauge/class, sealing, support, and underground/outdoor duct provisions. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-6-duct-systems#FLMC2023P2_Ch06_Sec603)
- **607 Duct & Transfer Openings (Fire/Smoke Dampers)** - Confirm damper locations at rated assemblies and access for maintenance. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-6-duct-systems#FLMC2023P2_Ch06_Sec607)

### Combustion Air (Ch 7)
- **701 General** - Verify combustion air for fuel-burning appliances is provided per the Fuel Gas Code/appliance listing. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-7-combustion-air#FLMC2023P2_Ch07_Sec701)

### Chimneys & Vents (Ch 8)
- **802/803 Vents & Connectors** - Check vent type/sizing and connector routing/clearances for the appliance category. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-8-chimneys-and-vents#FLMC2023P2_Ch08_Sec802)
- **805 Factory-Built Chimneys** - Verify listing, clearances, and termination height for factory-built chimneys. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-8-chimneys-and-vents#FLMC2023P2_Ch08_Sec805)

### Boilers & Refrigeration (Ch 10-11)
- **1002 Water Heaters (as space heat) / 1004 Boilers** - Check boiler location, clearances, mounting, and labeling. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-10-boilers-water-heaters-and-pressure-vessels#FLMC2023P2_Ch10_Sec1004)
- **1006 Safety & Pressure Relief** - Verify relief valve provisions and discharge piping for boilers/pressure vessels. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-10-boilers-water-heaters-and-pressure-vessels#FLMC2023P2_Ch10_Sec1006)
- **1105/1106 Refrigeration Machinery Rooms** - Check machinery room requirements, refrigerant quantity limits, ventilation, and detection. [Link](https://codes.iccsafe.org/content/FLMC2023P2/chapter-11-refrigeration#FLMC2023P2_Ch11_Sec1105)

## FBC Plumbing - 2023 8th Edition
Base: [2023 FBC Plumbing](https://codes.iccsafe.org/content/FLPC2023P2)

### Administration
- **101/102 Scope & Applicability** - Confirm plumbing scope falls under this (commercial) volume vs. the Residential volume. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-1-scope-and-administration#FLPC2023P2_Ch01_SubCh01_Sec101)
- **106 Permits** - Verify plumbing construction documents, riser/isometric diagrams, and fixture schedules are submitted. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-1-scope-and-administration#FLPC2023P2_Ch01_SubCh02_Sec106)

### Fixtures & Minimum Facilities (Ch 4)
- **403 Minimum Plumbing Facilities** - Check required fixture counts by occupancy/occupant load (water closets, lavatories, drinking fountains, service sinks). [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-4-fixtures-faucets-and-fixture-fittings#FLPC2023P2_Ch04_Sec403)
- **404 Accessible Plumbing Facilities** - Verify required accessible/family/assisted-use fixtures coordinate with the Accessibility Code. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-4-fixtures-faucets-and-fixture-fittings#FLPC2023P2_Ch04_Sec404)
- **405 Installation of Fixtures** - Check fixture clearances, spacing, and setting requirements. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-4-fixtures-faucets-and-fixture-fittings#FLPC2023P2_Ch04_Sec405)

### Water Heaters (Ch 5)
- **502/504 Installation & Safety Devices** - Verify water heater location, drain pan, T&P relief valve, and discharge routing. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-5-water-heaters#FLPC2023P2_Ch05_Sec504)

### Water Supply & Distribution (Ch 6)
- **604 Design of Building Water Distribution System** - Check pipe sizing, fixture unit demand, and minimum flow pressures. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-6-water-supply-and-distribution#FLPC2023P2_Ch06_Sec604)
- **608 Protection of Potable Water Supply (Backflow)** - Verify backflow prevention/cross-connection control assemblies and air gaps by hazard. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-6-water-supply-and-distribution#FLPC2023P2_Ch06_Sec608)
- **607 Hot Water Supply System** - Check hot water distribution, temperature limits, and recirculation/return where required. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-6-water-supply-and-distribution#FLPC2023P2_Ch06_Sec607)

### Sanitary Drainage (Ch 7)
- **709/710 Fixture Units & Drainage Sizing** - Verify DFU loads and drain/sewer pipe sizing and slope. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-7-sanitary-drainage#FLPC2023P2_Ch07_Sec710)
- **708 Cleanouts** - Check cleanout locations, spacing, and accessibility. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-7-sanitary-drainage#FLPC2023P2_Ch07_Sec708)
- **714 Backwater Valves** - Verify backwater valve provisions for fixtures below the next upstream manhole/backflow level. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-7-sanitary-drainage#FLPC2023P2_Ch07_Sec714)

### Indirect/Special Waste (Ch 8)
- **802 Indirect Wastes** - Check required air gaps/air breaks for food equipment, sterilizers, and similar. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-8-indirect-special-waste#FLPC2023P2_Ch08_Sec802)
- **803 Special Wastes** - Verify neutralizing/dilution treatment for corrosive or harmful waste before discharge. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-8-indirect-special-waste#FLPC2023P2_Ch08_Sec803)

### Vents (Ch 9)
- **906 Vent Pipe Sizing** - Check vent sizing against fixture units and developed length. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-9-vents#FLPC2023P2_Ch09_Sec906)
- **918 Air Admittance Valves** - Verify AAV use, location, and accessibility where mechanical venting is used. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-9-vents#FLPC2023P2_Ch09_Sec918)

### Traps, Interceptors & Separators (Ch 10)
- **1002 Trap Requirements** - Check trap seal, size, and prohibition of double-trapping/S-traps. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-10-traps-interceptors-and-separators#FLPC2023P2_Ch10_Sec1002)
- **1003 Interceptors & Separators** - Verify grease/oil/sand interceptor sizing and location for commercial kitchens and shops. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-10-traps-interceptors-and-separators#FLPC2023P2_Ch10_Sec1003)

### Storm Drainage (Ch 11)
- **1106 Size of Conductors, Leaders & Storm Drains** - Check storm pipe sizing against rainfall rate and roof area. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-11-storm-drainage#FLPC2023P2_Ch11_Sec1106)
- **1108 Secondary (Emergency) Roof Drains** - Verify secondary/overflow drainage is provided and independently routed. [Link](https://codes.iccsafe.org/content/FLPC2023P2/chapter-11-storm-drainage#FLPC2023P2_Ch11_Sec1108)

## FBC Fuel Gas - 2023 8th Edition
Base: [2023 FBC Fuel Gas](https://codes.iccsafe.org/content/FLFGC2023P1)

### Administration
- **101/102 Scope & Applicability** - Confirm fuel gas piping/appliance scope (natural gas and LP) applies to the project. [Link](https://codes.iccsafe.org/content/FLFGC2023P1/chapter-1-scope-and-administration#FLFGC2023P1_Ch01_SubCh01_Sec101)
- **106 Permits** - Verify gas piping plans, appliance schedules, and load/BTU demand data are submitted. [Link](https://codes.iccsafe.org/content/FLFGC2023P1/chapter-1-scope-and-administration#FLFGC2023P1_Ch01_SubCh02_Sec106)

### General Regulations (Ch 3)
- **303 Appliance Location** - Check permitted appliance locations and prohibitions (bedrooms, closets, hazardous areas). [Link](https://codes.iccsafe.org/content/FLFGC2023P1/chapter-3-general-regulations#FLFGC2023P1_Ch03_Sec303)
- **304 Combustion, Ventilation & Dilution Air** - Verify combustion air method and opening sizes for gas appliances. [Link](https://codes.iccsafe.org/content/FLFGC2023P1/chapter-3-general-regulations#FLFGC2023P1_Ch03_Sec304)
- **307 Condensate Disposal** - Check condensate drainage for condensing gas appliances. [Link](https://codes.iccsafe.org/content/FLFGC2023P1/chapter-3-general-regulations#FLFGC2023P1_Ch03_Sec307)

### Gas Piping Installations (Ch 4)
- **402 Pipe Sizing** - Verify pipe sizing against appliance demand, length, and allowable pressure drop. [Link](https://codes.iccsafe.org/content/FLFGC2023P1/chapter-4-gas-piping-installations#FLFGC2023P1_Ch04_Sec402)
- **403 Piping Materials** - Check approved pipe/tubing materials (including CSST) and fittings. [Link](https://codes.iccsafe.org/content/FLFGC2023P1/chapter-4-gas-piping-installations#FLFGC2023P1_Ch04_Sec403)
- **404 Piping System Installation** - Verify routing, protection, underground/concealed installation, and bonding of CSST. [Link](https://codes.iccsafe.org/content/FLFGC2023P1/chapter-4-gas-piping-installations#FLFGC2023P1_Ch04_Sec404)
- **406 Inspection, Testing & Purging** - Check required pressure test method, duration, and purging procedures. [Link](https://codes.iccsafe.org/content/FLFGC2023P1/chapter-4-gas-piping-installations#FLFGC2023P1_Ch04_Sec406)
- **409 Shutoff Valves** - Verify appliance and system shutoff valve locations and accessibility. [Link](https://codes.iccsafe.org/content/FLFGC2023P1/chapter-4-gas-piping-installations#FLFGC2023P1_Ch04_Sec409)
- **412 LP-Gas Motor Fuel / LP provisions** - Note LP-gas-specific piping and connection provisions where propane is used. [Link](https://codes.iccsafe.org/content/FLFGC2023P1/chapter-4-gas-piping-installations#FLFGC2023P1_Ch04_Sec412)

### Chimneys & Vents (Ch 5)
- **503 Venting of Appliances** - Check venting method by appliance category and connector requirements. [Link](https://codes.iccsafe.org/content/FLFGC2023P1/chapter-5-chimneys-and-vents#FLFGC2023P1_Ch05_Sec503)
- **504 Sizing of Category I Appliance Vents** - Verify vent sizing per tables/listing for Category I appliances. [Link](https://codes.iccsafe.org/content/FLFGC2023P1/chapter-5-chimneys-and-vents#FLFGC2023P1_Ch05_Sec504)

### Specific Appliances (Ch 6)
- **613/614 Clothes Dryers & Exhaust** - Check gas dryer connection and exhaust duct/termination requirements. [Link](https://codes.iccsafe.org/content/FLFGC2023P1/chapter-6-specific-appliances#FLFGC2023P1_Ch06_Sec614)
- **617 Pool & Spa Heaters** - Verify gas pool/spa heater installation and clearances. [Link](https://codes.iccsafe.org/content/FLFGC2023P1/chapter-6-specific-appliances#FLFGC2023P1_Ch06_Sec617)
- **618 Forced-Air Warm-Air Furnaces** - Check furnace installation, clearances, and duct connections. [Link](https://codes.iccsafe.org/content/FLFGC2023P1/chapter-6-specific-appliances#FLFGC2023P1_Ch06_Sec618)

#### Coverage notes
- All chapter slugs and section anchor ids were verified by navigating each chapter page and observing the rendered element ids and headings in the DOM.
- Chapter numbers render as two-digit anchors (Ch01-Ch11). Administrative Ch 1 sections carry an extra `SubCh01`/`SubCh02` segment; all other chapters use `..._Ch{nn}_Sec{n}`.
- Descriptions are paraphrased from section headings; confirm specific numeric thresholds/tables against the live section text.
- Fuel Gas sections carry `(IFGC)`/`(IFGS)` origin markers (standard model-code split, not Florida amendments). FBC Administrative Chapter 1 is a statewide Florida-customized chapter in all three volumes.
