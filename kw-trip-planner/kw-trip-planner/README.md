# KW Trip Planner

Mobile web app (Leaflet) for planning walk + bus + ION trips in Kitchener and Waterloo, Ontario.
Same app, look and symbology as the Guelph Trip Planner — only the data sources change.

* **Streets, trails, addresses** – Region of Waterloo Open Data (ArcGIS REST, loaded live and paged past the
  1,000-record limit; filtered to Kitchener + Waterloo in `js/config.js` → `municipalities`).
* **Transit** – Grand River Transit GTFS (`data/gtfs/*.json`, built with `scripts/build_gtfs.py`).
  The **Update GRT schedule** GitHub Action rebuilds it every Monday, or run it any time from the Actions tab.
* **Bus positions & alerts** – live GRT GTFS-Realtime feed via a Cloudflare Worker relay (`worker/`),
  refreshed every 15 s. With no relay set, the app runs on the timetable alone.
* **Walk area** – 5-minute walkshed over the street + trail network (`walkshedMinutes` in `js/config.js`).

## Rebuild the GTFS data by hand
```
unzip GRT_GTFS.zip -d gtfs
python3 scripts/build_gtfs.py gtfs data/gtfs
```

Deep link example: `?from=200 King St W&to=200 University Ave W`

Basemap © OpenStreetMap contributors. Data: Region of Waterloo Open Data, Grand River Transit. Created by Randy Harris.
