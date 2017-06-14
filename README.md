# moves-to-spatialite
PhD #02 - Importing Moves Storyline Data into SQLite / SpatiaLite

## Intro
This set of scripts help you import a Moves GeoJson export into an SQLite + SpatiaLite database (a switch to PostgreSQL + PostGIS should be very easy. Probably just switch the DB connector).

To get your own Moves data, go to: https://accounts.moves-app.com/export?download=true

_If you have an old export, get a new one, the at some point they updated the exporter, the old exports contain errors trailing commas for example._

## Usage

Please be aware, this is a dependency heavy script, especially spatialite.

```
node index.js PATH_TO/story.geojson OUTPUT_FOLDER_NAME RUN_TESTS
```
The first parameter is simply the path to the geojson, that should be imported (including the filename). Second parameter is simply the name of the output folder (default is _temp\_TIMESTAMP_). If the folder already exists, everything inside is being overwritten (no warning). The last parameter should be TRUE if you want to run tests (see below), otherwise just ignore. Be aware, if the test parameter is true, some trajectories will be flagged test and are not included in corridors nor clusters, in order to use them as a test-dataset (e.g. for validation).

### Output

#### Structure

There is a lot of stuff happening inside that script. Let's first take a look a the database structure that is generated. Below is a list of tables and their function, a full list of tables and their columns is available in **structure.sql**.

Table | Function
------------ | -------------
locations | locations (!)
location_merge | Moves contains duplicate locations, everytime a location is merged their original ids are stored in here
location_slpa | network-analysis results (ngraph-slpa)
location_events | Every time a user stays at a location an event is created
trips | Trip between two locations
trip_segments | Segments of a trip between two locations (separated by activity type or break)
corridors | corridors grouped trips including hull geometry
corridor_trips | many to many table for storing connections between corridors and trips
clusters | location clusters including a hull geometry
cluster_locations | many to many table for storing connections between clusters and locations
temp_query | In some cases its faster to use a temporary table for running big queries

#### Processing

Moves' featureCollection object is parsed and separated into trips and locations. The trajectories of the trips are furthermore split into segments based on activity. Each segment is optimized using a median filter and simplified through the Douglas-Peucker algorithm. And some other trajectory cleaning functions. Locations are checked for duplicates based on name, id and a spatial threshold (The IDs of merged locations are kept). Afterwards the resulting data is inserted into the SQLite database. 

If RUN_TESTS is TRUE, the system checks where trip occur more than twice and then keeps some trajectories in a test collection, which are not used for the further calculations (column test=1).

Next the locations are clustered based on a combination of DBSCAN and network connection analysis, which means, that distance checks are only performed on locations which are connected through trips. The resulting clusters are stored in an additional table.

Based on the trajectories between locations and between clusters, the system builds so called corridors which are basically merged trajectories with a buffer and a hull.

The location metadata is extended through a network analysis making use of:
- ngraph.centrality
- ngraph.slpa
- ngraph.cw
- ngraph.louvain
- ngraph.pagerank
- ngraph.hits

Several geojsons are automatically generated:
- clusters.geojson
- corridors.geojson

If RUN\_TESTS is TRUE, a prediction test is run based on the corridors and the selected test trips. The test consists of 3 steps. The test trip is broken down into smaller segments. Then the 1, 1+2, 1+2+3, 1+n segments are intersected with the corridors. For the resulting corridors the temporal information is retrieved which is then fed into an KNN algorithm, which tries to predict the most likely corridor. The results are stored in knn\_test\_results.json

## DB Query

As mentioned above, the resulting SQLite database is saved in a DB file. If you quickly want to extract something. You can use query.js, its pretty straight forward:

```
node query.js NAME_OF_DB_FILE "SELECT COUNT(*) FROM locations" OUTPUT_FILE_NAME
```

For readability drop file extension .db and .json from the file names.

If you want a GUI i can recommend SQLite Browser: http://sqlitebrowser.org
(Although i have to admit, i haven't been able to get spatialite running in that application, but in theory it should be possible.)

## Copyright
Everything in this repo is available under GPLv3. 