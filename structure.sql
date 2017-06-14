CREATE TABLE locations ( 
  id integer NOT NULL PRIMARY KEY AUTOINCREMENT, 
  name text, 
  cluster_id integer, 
  transit integer DEFAULT 0, 
  destination integer DEFAULT 0, 
  type text, 
  fs_id text, 
  --Degree of Centrality
  dc float DEFAULT 0, 
  --DC in
  dc_in float DEFAULT 0, 
  --DC out
  dc_out float DEFAULT 0, 
  --Betweenness
  bc float DEFAULT 0, 
  --pagerank
  pagerank float DEFAULT 0,  
  --louvain neighbourhood
  louvain float DEFAULT 0, 
  --hits - authority
  h_authority float DEFAULT 0, 
  --hits - hub
  h_hub float DEFAULT 0, 
  --cw cluster
  cw float DEFAULT 0 
); 
SELECT AddGeometryColumn('locations', 'the_geom', 4326, 'POINT', 'XY');
SELECT CreateSpatialIndex('locations', 'the_geom');

CREATE TABLE location_merge ( 
  location_id integer NOT NULL, 
  moves_id integer NOT NULL 
);

CREATE TABLE location_slpa ( 
  location_id integer NOT NULL, 
  name text, 
  probability float
);

CREATE TABLE location_events ( 
  id integer NOT NULL PRIMARY KEY AUTOINCREMENT, 
  location_id integer NOT NULL, 
  --10 minute interval of 24 hours, starts at 04:00
  start_10_min integer NOT NULL, 
  end_10_min integer NOT NULL, 
  day_of_week integer NOT NULL, 
  month integer NOT NULL, 
  --UNIX TIMESTAMP
  start_timestamp TIMESTAMP NOT NULL, 
  end_timestamp TIMESTAMP NOT NULL, 
  duration integer NOT NULL 
);

CREATE TABLE trips ( 
  id integer NOT NULL PRIMARY KEY AUTOINCREMENT, 
  from_id integer NOT NULL, 
  to_id integer NOT NULL, 
  from_cluster integer, 
  to_cluster integer, 
  --10 minute interval of 24 hours, starts at 04:00
  start_10_min integer NOT NULL, 
  end_10_min integer NOT NULL, 
  day_of_week integer NOT NULL, 
  month integer NOT NULL, 
  /*
    if corr_test is true, some trips are excluded from the corridor calculations and assigned a test flag
    those trips can then be used against the computed corridors to test the accuracy
  */
  test integer DEFAULT 0, 
  --UNIX TIMESTAMP
  start_timestamp TIMESTAMP NOT NULL, 
  end_timestamp TIMESTAMP NOT NULL, 
  duration integer NOT NULL 
);

CREATE TABLE trip_segments ( 
  id integer NOT NULL PRIMARY KEY AUTOINCREMENT, 
  trip_id integer NOT NULL, 
  from_id integer, 
  to_id integer, 
  activity text, 
  sequence integer 
);
SELECT AddGeometryColumn('trip_segments', 'the_geom', 4326, 'LINESTRING', 'XY'); 
SELECT CreateSpatialIndex('trip_segments', 'the_geom');

CREATE TABLE corridors ( 
  id integer NOT NULL PRIMARY KEY AUTOINCREMENT, 
  from_id integer NOT NULL, 
  to_id integer NOT NULL, 
  from_cluster integer, 
  to_cluster integer 
); 
SELECT AddGeometryColumn('corridors', 'the_geom', 4326, 'POLYGON', 'XY'); 
SELECT CreateSpatialIndex('corridors', 'the_geom');

CREATE TABLE corridor_trips ( 
  corridor_id integer NOT NULL, 
  trip_id integer NOT NULL
);

CREATE TABLE clusters ( 
  id integer NOT NULL PRIMARY KEY AUTOINCREMENT 
);
SELECT AddGeometryColumn('clusters', 'the_geom', 4326, 'MULTIPOLYGON', 'XY'); 
SELECT CreateSpatialIndex('clusters', 'the_geom');

CREATE TABLE cluster_locations ( 
  cluster_id integer NOT NULL, 
  location_id integer NOT NULL
);

CREATE TABLE temp_query ( 
  id integer NOT NULL 
);
SELECT AddGeometryColumn('temp_query', 'the_geom', 4326, 'POLYGON', 'XY'); 
SELECT CreateSpatialIndex('temp_query', 'the_geom');