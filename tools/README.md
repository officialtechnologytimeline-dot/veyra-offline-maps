# VEYRA country-map build tools

These are data-conversion and verification tools only. They contain no VEYRA application UI, application source, signing keys, analytics service, or user data.

The monthly workflow uses a standard public GitHub Actions Ubuntu runner (free under GitHub's current plan), pyosmium 4.3.1 and the official PMTiles CLI 1.31.2. No paid runner, external API key, subscription or persistent personal token is needed. GitHub supplies a short-lived repository token to publish releases and update the catalog.

Only explicitly reviewed country profiles are built. Currently this is **Monaco**, not Italy or global coverage. Adding a country requires testing data completeness, memory use and routing before adding a profile. The mobile routing engine still loads a whole country graph, so large countries must not be enabled without memory acceptance tests.

Each build uses real OpenStreetMap/Geofabrik data and a recent compatible Protomaps basemap. It checks formats, coordinates, graph references, search coverage, real POIs, known restriction warnings, map bounds and SHA-256. New unparsed restriction counts, schema changes, missing sources or an excessive download size stop publication. These checks are not certification of road restrictions or vehicle-specific route safety.

Only after all published map artifacts have been downloaded anonymously and their hashes verified is `catalog.json` updated. The app checks that catalog and offers updates for installed countries, in the selected language. It never downloads a country automatically. Existing packages remain installed until a full verified update commits.

If a run fails, the previous catalog remains active and GitHub shows the failed run. The owner receives normal GitHub Actions notifications according to their account settings. Scheduled Actions can be delayed; GitHub may disable a public scheduled workflow after 60 days without repository activity. The owner can use **Actions → Refresh country maps → Run workflow** or re-enable it. Free hosting is subject to GitHub's ongoing policies, not a permanent unlimited service guarantee.

Sources and map licensing: [ATTRIBUTION.md](../ATTRIBUTION.md). Do not remove data attribution. No map license grants rights to VEYRA's private application source.
