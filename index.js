if(process.argv.length<3){
  console.log('PATH_TO/story.geojson needs to be provided as first parameter');
  process.exit();
}else{
  var file = process.argv[2],
    dbname = 'temp_'+ Date.now()
    corr_test = false

  if(process.argv.length > 3){
    dbname = process.argv[3]
  }
  if(process.argv.length > 4){
    if(process.argv[4] == 'TRUE'){
      corr_test = true
    }
  }
}

let fs = require('fs'),
    turf = require('turf'),
    d3 = require('d3'),
    moment = require('moment-timezone'),
    sql = require('spatialite'),
    zone = 'Europe/Amsterdam',
    knn = require('alike'),
    ng_centrality = require('ngraph.centrality'),
    ng_slpa = require('ngraph.slpa'),
    ng_cw = require('ngraph.cw'),
    ng_louvain = require('ngraph.louvain'),
    ng_pagerank = require('ngraph.pagerank'),
    ng_hits = require('ngraph.hits'),
    ngraph = require('ngraph.graph')()

let dev_time = moment()
function dev_diff(){
  let t_time = moment()
  return dev_time.diff(t_time)
}

//Check if output folder exists
if(dbname.substr(-1,1) != '/'){ 
  dbname += '/' 
}
if (!fs.existsSync(dbname)) {
  fs.mkdirSync(dbname)
}
 
let db = new sql.Database(dbname+'database.db', function(err){
  if(err) console.log(err);

  init();
});

var tables = [
  {
    name : 'locations',
    create :
      "CREATE TABLE locations ( "+
          "id integer NOT NULL PRIMARY KEY AUTOINCREMENT, "+
          "name text, "+
          "cluster_id integer, "+
          "transit integer DEFAULT 0, "+
          "destination integer DEFAULT 0, "+
          "type text, "+
          "fs_id text, "+
          //Degree of Centrality
          "dc float DEFAULT 0, "+
          //DC in
          "dc_in float DEFAULT 0, "+
          //DC out
          "dc_out float DEFAULT 0, "+
          //Betweenness
          "bc float DEFAULT 0, "+
          //Pagerank
          "pagerank float DEFAULT 0, "+
          //louvain neighbourhood
          "louvain float DEFAULT 0, "+
          //hits - authority
          "h_authority float DEFAULT 0, "+
          //hits - hub
          "h_hub float DEFAULT 0, "+
          //cw cluster
          "cw float DEFAULT 0 "+
      "); "+

      "SELECT AddGeometryColumn('locations', 'the_geom', 4326, 'POINT', 'XY'); "+
      "SELECT CreateSpatialIndex('locations', 'the_geom');"
  },
  {
    name : 'location_merge',
    create :
      "CREATE TABLE location_merge ( "+
          "location_id integer NOT NULL, "+
          "moves_id integer NOT NULL "+
      ");"
  },
  {
    name : 'location_slpa',
    create :
      "CREATE TABLE location_slpa ( "+
          "location_id integer NOT NULL, "+
          "name text, "+
          "probability float"+
      ");"
  },
  {
    name : 'location_events',
    create :
      "CREATE TABLE location_events ( "+
          "id integer NOT NULL PRIMARY KEY AUTOINCREMENT, "+
          "location_id integer NOT NULL, "+
          //10 minute interval of 24 hours, starts at 04:00
          "start_10_min integer NOT NULL, "+
          "end_10_min integer NOT NULL, "+
          "day_of_week integer NOT NULL, "+
          "month integer NOT NULL, "+
          //UNIX TIMESTAMP
          "start_timestamp TIMESTAMP NOT NULL, "+
          "end_timestamp TIMESTAMP NOT NULL, "+
          "duration integer NOT NULL "+
      ");"
  },
  {
    name : 'trips',
    create :
      "CREATE TABLE trips ( "+
          "id integer NOT NULL PRIMARY KEY AUTOINCREMENT, "+
          "from_id integer NOT NULL, "+
          "to_id integer NOT NULL, "+
          "from_cluster integer, "+
          "to_cluster integer, "+
          //10 minute interval of 24 hours, starts at 04:00
          "start_10_min integer NOT NULL, "+
          "end_10_min integer NOT NULL, "+
          "day_of_week integer NOT NULL, "+
          "month integer NOT NULL, "+
          /*
            if corr_test is true, some trips are excluded from the corridor calculations and assigned a test flag
            those trips can then be used against the computed corridors to test the accuracy
          */
          "test integer DEFAULT 0, "+
          //UNIX TIMESTAMP
          "start_timestamp TIMESTAMP NOT NULL, "+
          "end_timestamp TIMESTAMP NOT NULL, "+
          "duration integer NOT NULL "+
      "); "
  },
  {
    name : 'trip_segments',
    create :
      "CREATE TABLE trip_segments ( "+
          "id integer NOT NULL PRIMARY KEY AUTOINCREMENT, "+
          "trip_id integer NOT NULL, "+
          "from_id integer, "+
          "to_id integer, "+
          "activity text, "+
          "sequence integer "+
      "); "+
      "SELECT AddGeometryColumn('trip_segments', 'the_geom', 4326, 'LINESTRING', 'XY'); "+
      "SELECT CreateSpatialIndex('trip_segments', 'the_geom');"
  },
  {
    name : 'corridors',
    create :
      "CREATE TABLE corridors ( "+
          "id integer NOT NULL PRIMARY KEY AUTOINCREMENT, "+
          "from_id integer NOT NULL, "+
          "to_id integer NOT NULL, "+
          "from_cluster integer, "+
          "to_cluster integer "+
      "); "+
      "SELECT AddGeometryColumn('corridors', 'the_geom', 4326, 'POLYGON', 'XY'); "+
      "SELECT CreateSpatialIndex('corridors', 'the_geom');"
  },
  {
    name : 'corridor_trips',
    create :
      "CREATE TABLE corridor_trips ( "+
          "corridor_id integer NOT NULL, "+
          "trip_id integer NOT NULL"+
      "); "
  },
  {
    name : 'clusters',
    create :
      "CREATE TABLE clusters ( "+
          "id integer NOT NULL PRIMARY KEY AUTOINCREMENT "+
      "); "+
      "SELECT AddGeometryColumn('clusters', 'the_geom', 4326, 'MULTIPOLYGON', 'XY'); "+
      "SELECT CreateSpatialIndex('clusters', 'the_geom');"
  },
  {
    name : 'cluster_locations',
    create :
      "CREATE TABLE cluster_locations ( "+
          "cluster_id integer NOT NULL, "+
          "location_id integer NOT NULL"+
      "); "
  },
  {
    name : 'temp_query',
    create :
      "CREATE TABLE temp_query ( "+
          "id integer NOT NULL "+
      "); "+
      "SELECT AddGeometryColumn('temp_query', 'the_geom', 4326, 'POLYGON', 'XY'); "+
      "SELECT CreateSpatialIndex('temp_query', 'the_geom');"
  }
];

//These are average values generated from user files, these are used to spot errors (outliers) in the data
var training = {}

//These first functions setup the SQLite database, if the database already exists, it deletes all entries
var table_count = 0;
function checkForTables(){
  tableExists(tables[table_count].name, function(err, data){
    if(err) console.log(err);

    if(typeof data === 'undefined'){
      db.exec(tables[table_count].create, function(err){
        if(err){
          console.log(err, tables[table_count].create);
        }else{
          checkNextTable();
        }
      });
    }else{
      db.run("DELETE FROM "+tables[table_count].name, function(err){
        if(err) console.log(err)
        db.run("DELETE FROM sqlite_sequence where name='"+tables[table_count].name+"'", function(err){
          if(err) console.log(err)
          checkNextTable()
        })
      })     
    }
  })
}

function checkNextTable(){
  table_count++;
  if(table_count<tables.length){
    setTimeout(checkForTables, 1);
  }else{
    console.log('init_done',dev_diff())
    loadData();
  }
}

function init(){
  console.log('init_start',dev_diff())
  db.spatialite(function(err) {
    if(err) console.log(err);

    tableExists('spatial_ref_sys', function(err, data){
      if(err) console.log(err)

      if(typeof data === 'undefined'){
        db.run("SELECT InitSpatialMetaData()", function(err){
          if(err) console.log(err)
          checkForTables()
        });
      }else{
        checkForTables()
      }
    });
  });
}

function locationEventFromFeature(f){
  if(!('startTime' in f.properties)){
    return false
  }else{
    if(f.properties.startTime == f.properties.endTime){
      return false
    }else{
      return {
        start:f.properties.startTime,
        end:f.properties.endTime,
        location:f.properties.place.id
      }
    }
  }
}

let geojson, locations = [], trajectories = [];

//Loading the geojson and parsing the featureCollection and separating it into locations and trips
//This step checks for duplicate locations using an spatial threshold
//Every stop at a location gets transformed into an event

function loadData(){
  console.log('load_start',dev_diff())
  fs.readFile(file, 'utf8', function (err,data) {
    if (err) { return console.log(err); }

    console.log('load_done',dev_diff())
    console.log('parse_start',dev_diff())
    geojson = JSON.parse(data)

    //First loop through the file and extract all locations
    let locations_keys = {}, location_merge_keys = {}, min_dist = 50

    //sometimes an location event is broken up into multiple pieces, this first loop stitches them back together
    let i = 0
    while(i<geojson.features.length){
      if(i<(geojson.features.length-1)){
        if(geojson.features[i].properties.type == 'place' && geojson.features[i+1].properties.type == 'place'){
          if(geojson.features[i].properties.place.id == geojson.features[i+1].properties.place.id){
            //merge
            geojson.features[i].properties.endTime = geojson.features[i+1].properties.endTime
            geojson.features.splice(i+1,1)
            i--
          }
        }else if(geojson.features[i].properties.type == 'move' && geojson.features[i+1].properties.type == 'move'){
          //merge
          geojson.features[i].properties.endTime = geojson.features[i+1].properties.endTime
          geojson.features[i].properties.activities = geojson.features[i].properties.activities.concat(geojson.features[i+1].properties.activities)
          geojson.features[i].geometry.coordinates = geojson.features[i].geometry.coordinates.concat(geojson.features[i+1].geometry.coordinates)
          geojson.features.splice(i+1,1)
          i--
        }
      }
      i++
    }

    //collecting training data
    geojson.features.forEach( feature => {
      if(feature.properties.type == 'move'){
        for(let a = 0; a<feature.properties.activities.length; a++){
          let activity = feature.properties.activities[a].activity
          for(let c = 1; c<feature.geometry.coordinates[a].length; c++){
            //TODO: LONG DISTANCE TRANSPORT !!!!
            if(!(activity in training)){
              training[activity] = {dists:[]}
            }
            training[activity].dists.push(turf.distance(turf.point(feature.geometry.coordinates[a][c]),turf.point(feature.geometry.coordinates[a][c-1])))
          }
        }
      }
    })

    for(var t in training){
      training[t]['min'] = d3.min(training[t].dists)
      training[t]['max'] = d3.max(training[t].dists)
      training[t]['mean'] = d3.mean(training[t].dists)
      training[t]['median'] = d3.median(training[t].dists)
      training[t]['quantiles'] = [d3.quantile(training[t].dists, .25), d3.quantile(training[t].dists, .5), d3.quantile(training[t].dists, .75)]

      let k = 1.5 // 1.5
      var q1 = training[t].quantiles[0],
          q3 = training[t].quantiles[2],
          iqr = (q3 - q1) * k,
          ii = -1,
          j = training[t].dists.length;
      while (training[t].dists[++ii] < q1 - iqr);
      while (training[t].dists[--j] > q3 + iqr);

      training[t]['iqr'] = [training[t].dists[ii],training[t].dists[j]]
    }

    function add_transit_location(feature, a, t_count, side){
      return {
        properties:{
          type:'place',
          place:{
            transit:true,
            name:'unknown',
            type:'unknown',
            id:t_count*-1,
            location:{
              lat: feature.geometry.coordinates[a][((side==='first')?0:(feature.geometry.coordinates[a].length-1))][1],
              lon: feature.geometry.coordinates[a][((side==='first')?0:(feature.geometry.coordinates[a].length-1))][0]
            }
          }
        },
        geometry:{
          coordinates:feature.geometry.coordinates[a][((side==='first')?0:(feature.geometry.coordinates[a].length-1))]
        }
      }
    }

    //prepend transit locations to the storyline (so we don't need to )
    let transit_locations = [], t_count = 1
    for(var f = 0; f<geojson.features.length; f++){
      let feature = geojson.features[f]
      if(feature.properties.type == 'move'){
        for(var a = 0; a<feature.properties.activities.length; a++){
          transit_locations.push(add_transit_location(feature, a, t_count, 'first'))
          t_count++

          transit_locations.push(add_transit_location(feature, a, t_count, 'last'))
          t_count++
        }
      }
    }

    geojson.features = transit_locations.concat(geojson.features)

    location_geo_keys = {}

    for(var f = 0; f<geojson.features.length; f++){
      let feature = geojson.features[f]

      if(feature.properties.type == 'place'){
        if(!('name' in feature.properties.place)) feature.properties.place['name'] = 'unknown'

        //check if location already exists

        if(feature.properties.place.id in locations_keys){
          //location already exists, just check if the name is good
          if(locations[locations_keys[feature.properties.place.id]].type == 'unknown'){
            locations[locations_keys[feature.properties.place.id]].type = feature.properties.place.type
          }
          if(locations[locations_keys[feature.properties.place.id]].name == 'unknown'){
            locations[locations_keys[feature.properties.place.id]].name = feature.properties.place.name
          }
          if(locations[locations_keys[feature.properties.place.id]].fs_id == 0 && ('foursquareId' in feature.properties.place)){
            locations[locations_keys[feature.properties.place.id]].fs_id = feature.properties.place.foursquareId
          }
          locations[locations_keys[feature.properties.place.id]].destination += 1
        }else if(feature.properties.place.id in location_merge_keys){
          //location was already merged
          if(locations[location_merge_keys[feature.properties.place.id]].type == 'unknown'){
            locations[location_merge_keys[feature.properties.place.id]].type = feature.properties.place.type
          }
          if(locations[location_merge_keys[feature.properties.place.id]].fs_id == 0 && ('foursquareId' in feature.properties.place)){
            locations[location_merge_keys[feature.properties.place.id]].fs_id = feature.properties.place.foursquareId
          }
          if(locations[location_merge_keys[feature.properties.place.id]].name == 'unknown'){
            locations[location_merge_keys[feature.properties.place.id]].name = feature.properties.place.name
          }
          locations[location_merge_keys[feature.properties.place.id]].destination += 1
        }else if((feature.properties.place.location.lon+"_"+feature.properties.place.location.lat in location_geo_keys)){
          if(locations[location_geo_keys[feature.properties.place.location.lon+"_"+feature.properties.place.location.lat]].type == 'unknown'){
            locations[location_geo_keys[feature.properties.place.location.lon+"_"+feature.properties.place.location.lat]].type = feature.properties.place.type
          }
          if(locations[location_geo_keys[feature.properties.place.location.lon+"_"+feature.properties.place.location.lat]].fs_id == 0 && ('foursquareId' in feature.properties.place)){
            locations[location_geo_keys[feature.properties.place.location.lon+"_"+feature.properties.place.location.lat]].fs_id = feature.properties.place.foursquareId
          }
          if(locations[location_geo_keys[feature.properties.place.location.lon+"_"+feature.properties.place.location.lat]].name == 'unknown'){
            locations[location_geo_keys[feature.properties.place.location.lon+"_"+feature.properties.place.location.lat]].name = feature.properties.place.name
          }
          locations[location_geo_keys[feature.properties.place.location.lon+"_"+feature.properties.place.location.lat]].destination += 1
          locations[location_geo_keys[feature.properties.place.location.lon+"_"+feature.properties.place.location.lat]].merged.push(feature.properties.place.id)
          location_merge_keys[feature.properties.place.id] = location_geo_keys[feature.properties.place.location.lon+"_"+feature.properties.place.location.lat]
        }else{
          let exist = false, exist_dist = Number.MAX_VALUE, more_likely = false
          locations.forEach( (location, l) => {
            let dist = Math.round(turf.distance(turf.point([location.lon, location.lat]), turf.point([feature.geometry.coordinates[0],feature.geometry.coordinates[1]]))*1000)
            if(dist < min_dist && dist < exist_dist){
              exist = l
              exist_dist = dist
            }
            if(dist < min_dist){
              if(
                (feature.properties.place.name != 'unknown') && 
                (
                  (locations[exist].type == feature.properties.place.type) && 
                  (locations[exist].name == feature.properties.place.name)
                )
              ){
                more_likely = l
              }
            }
          })

          if(more_likely){
            exist = more_likely
          }

          if(!exist){
            locations.push({
              lat:feature.properties.place.location.lat,
              lon:feature.properties.place.location.lon,
              name:feature.properties.place.name,
              type:feature.properties.place.type,
              id:feature.properties.place.id,
              fs_id:('foursquareId' in feature.properties.place)?feature.properties.place.foursquareId:0,
              destination:('transit' in feature.properties.place)?0:1,
              transit:('transit' in feature.properties.place)?1:0,
              events:[],
              merged:[feature.properties.place.id]
            })

            location_geo_keys[feature.properties.place.location.lon+"_"+feature.properties.place.location.lat] = locations_keys[feature.properties.place.id] = locations.length-1
          }else{
            let closeby = false
            if((locations[exist].type == feature.properties.place.type) && 
              (locations[exist].name == feature.properties.place.name)){
              //same name and type
            }else if(
              (locations[exist].type == 'unknown') &&
              (locations[exist].name == 'unknown')
            ){
              locations[exist].type = feature.properties.place.type
              locations[exist].name = feature.properties.place.name
            }else if(
              (locations[exist].name == 'unknown') && (locations[exist].type == feature.properties.place.type)
            ){
              locations[exist].name = feature.properties.place.name
            }else if(
              (locations[exist].type == 'unknown') && (locations[exist].name == feature.properties.place.name)
            ){
              locations[exist].name = feature.properties.place.name
            }else{
              closeby = true
            }

            if(!closeby){
              if(locations[exist].fs_id == 0 && ('foursquareId' in feature.properties.place)){
                locations[exist].fs_id = feature.properties.place.foursquareId
              }
              location_geo_keys[feature.properties.place.location.lon+"_"+feature.properties.place.location.lat] = location_merge_keys[feature.properties.place.id] = exist
              if(('transit' in feature.properties.place)){
                locations[exist].transit += 1
              }else{
                locations[exist].destination += 1
              }
              locations[exist].merged.push(feature.properties.place.id)
            }else{
              locations.push({
                lat:feature.properties.place.location.lat,
                lon:feature.properties.place.location.lon,
                name:feature.properties.place.name,
                type:feature.properties.place.type,
                id:feature.properties.place.id,
                fs_id:('foursquareId' in feature.properties.place)?feature.properties.place.foursquareId:0,
                destination:('transit' in feature.properties.place)?0:1,
                transit:('transit' in feature.properties.place)?1:0,
                events:[],
                merged:[feature.properties.place.id]
              })

              location_geo_keys[feature.properties.place.location.lon+"_"+feature.properties.place.location.lat] = locations_keys[feature.properties.place.id] = locations.length-1
            }
          }
        }

        let l_event = locationEventFromFeature(feature)

        if(l_event){

          if(feature.properties.place.id in location_merge_keys){
            if(!eventExists(locations[location_merge_keys[feature.properties.place.id]].events,l_event)){
              locations[location_merge_keys[feature.properties.place.id]].events.push(l_event)
            }
          }else if(feature.properties.place.id in locations_keys){
            if(!eventExists(locations[locations_keys[feature.properties.place.id]].events,l_event)){
              locations[locations_keys[feature.properties.place.id]].events.push(l_event)
            }
          }else{
            console.log('whoops')
          }

        }
      }else if(feature.properties.type == 'move'){
        let prev = geojson.features[f-1],
          next = geojson.features[f+1],
          obj = {
            origin:prev.properties.place.id,
            destination:next.properties.place.id,
            end:moment.tz(feature.properties.endTime, zone),
            start:moment.tz(feature.properties.startTime, zone),
            segments:[]
          };

        for(var a = 0; a < feature.properties.activities.length; a++){
          var activity = feature.properties.activities[a].activity;
          var geometry = validateLine(feature.geometry.coordinates[a], activity.activity);  //validateLine(feature.geometry.coordinates[a], activity.activity, 0); //feature.geometry.coordinates[a];
          if(geometry.length < 1){
            console.log('shit',feature.geometry.coordinates.length, feature.geometry.coordinates[a])
          }else{
            let from_id = feature.geometry.coordinates[a][0][0]+"_"+feature.geometry.coordinates[a][0][1],
              to_id = feature.geometry.coordinates[a][feature.geometry.coordinates[a].length-1][0]+"_"+feature.geometry.coordinates[a][feature.geometry.coordinates[a].length-1][1]

            if(from_id in location_geo_keys){
              from_id = locations[location_geo_keys[from_id]].merged[0]
            }else{
              from_id = false
            }

            if(to_id in location_geo_keys){
              to_id = locations[location_geo_keys[to_id]].merged[0]
            }else{
              to_id = false
            }

            obj.segments.push({
              activity:activity,
              from:from_id,
              to:to_id,
              geometry:geometry
            })
          }
        }
        trajectories.push(obj);
      }else{
        console.log('unknown type', feature.properties.type)
      }
    }

    console.log('parse_done',dev_diff())
    console.log('insert_start',dev_diff())
    insertLocation(0)
  });
}

function eventExists(events, event){
  let exists = false

  events.forEach( e => {
    if(event.start === e.start && event.end === e.end){
      exist = true
    }
  })

  return exists
}

function reFormatHour(h){
  var nh = h-4;
  if(nh<0){
    nh += 24
  }
  return nh
}

function reFormatTime(time){
  return Math.round((reFormatHour(parseInt(time.format('H')))*60 + parseInt(time.format('m')))/10)
}

function calcDuration(start,end){
  let end_10_min = reFormatTime(end),
    start_10_min = reFormatTime(start)
  let duration = end_10_min-start_10_min+1,

  diff = Math.abs(end.diff(start, 'days'))

  if(end_10_min < start_10_min){
    duration = 144 - start_10_min + end_10_min + 1
    if(diff > 1){
      duration += 144 * (diff-1)
    }
  }else if(diff > 0){
    duration += 144 * diff
  }

  return duration
}

//Inserting everything

let locations_keys = {}, test_corrs = {}, test_corrs_limit = 2

function insertLocation(i){
  //Insert all locations and location event into the database and create a new array including the unique database IDs

  db.run("INSERT INTO locations (name, type, transit, destination, the_geom, fs_id) VALUES ('"+locations[i].name+"', '"+locations[i].type+"', "+locations[i].transit+", "+locations[i].destination+", GeomFromText('POINT("+locations[i].lon+" "+locations[i].lat+")', 4326),'"+locations[i].fs_id+"')", function(err){
    if(err) console.log(err);
    var loc_id = this.lastID

    var merge_query = "";
    locations[i].merged.forEach(function(l){
      locations_keys[l] = loc_id
      merge_query += "INSERT INTO location_merge (location_id, moves_id) VALUES ("+loc_id+","+l+");";
    })

    var event_query = "";
    locations[i].events.forEach(function(e){
      let start = moment.tz(e.start, zone),
        end = moment.tz(e.end, zone),
        start_timestamp = start.format('X'),
        end_timestamp = end.format('X'),
        month = start.format('M'),
        day_of_week = start.format('d'),
        start_10_min = reFormatTime(start),
        end_10_min = reFormatTime(end),
        duration = calcDuration(start,end)

      event_query += "INSERT INTO location_events (location_id, start_timestamp, end_timestamp, month, day_of_week, start_10_min, end_10_min, duration) VALUES ("+loc_id+","+start_timestamp+","+end_timestamp+","+month+","+day_of_week+","+start_10_min+","+end_10_min+", "+duration+");";
    })

    db.exec(merge_query, function(){
      db.exec(event_query, function(){
        i++
        if(i<locations.length){
          insertLocation(i)
        }else{
          if(corr_test){
            t_count = {}
            trajectories.forEach(t => {
              let from = locations_keys[t.origin],
                to = locations_keys[t.destination],
                ft_id = from+"_"+to

              if(!(ft_id in t_count)){
                t_count[ft_id] = 0
              }
              
              t_count[ft_id]++
            })

            for(let ft_id  in t_count){
              if(t_count[ft_id]>test_corrs_limit){
                test_corrs[ft_id] = Math.round(t_count[ft_id]*0.3)
              }
            }
          }

          console.log('insert_done',dev_diff())
          console.log('insert_start',dev_diff())
          insert_trajectories(0)
        }
      }) 
    })
  });
}

let test_trajectories = []

function insert_trajectories(i){
  let t = trajectories[i]

  let start = moment.tz(t.start, zone),
    end = moment.tz(t.end, zone),
    start_timestamp = start.format('X'),
    end_timestamp = end.format('X'),
    month = start.format('M'),
    day_of_week = start.format('d'),
    start_10_min = reFormatTime(start),
    end_10_min = reFormatTime(end),
    duration = calcDuration(start,end),
    ft_id = locations_keys[t.origin]+"_"+locations_keys[t.destination],
    is_test = 0

    if( (ft_id in test_corrs) ){
      if(test_corrs[ft_id]>0){
        is_test = 1
        test_corrs[ft_id]--
      }
    }

  db.run("INSERT INTO trips (test, from_id, to_id, start_timestamp, end_timestamp, month, day_of_week, start_10_min, end_10_min, duration) VALUES ("+is_test+","+locations_keys[t.origin]+","+locations_keys[t.destination]+","+start_timestamp+","+end_timestamp+","+month+","+day_of_week+","+start_10_min+","+end_10_min+", "+duration+")", function(err){
    if(err) console.log(err)    

    var trip_id = this.lastID

    if(is_test){
      test_trajectories.push(trip_id)
    }

    var segment_query = "";
    t.segments.forEach( (s,si) => {
      segment_query += "INSERT INTO trip_segments (trip_id, from_id, to_id, activity, sequence, the_geom) VALUES ("+trip_id+","+((s.from)?locations_keys[s.from]:'NULL')+", "+((s.to)?locations_keys[s.to]:'NULL')+", '"+s.activity+"',"+si+",GeomFromText('LINESTRING("+lineToText(s.geometry)+")', 4326));";
    })

    db.exec(segment_query, function(err){
      if(err) console.log(err)
      i++
      if(i<trajectories.length){
        insert_trajectories(i)
      }else{
        console.log('insert_done',dev_diff())
        console.log('corridor_start',dev_diff())
        buildCorridors()
      }
    })
  })
}

function buildCorridors(){
  db.all('SELECT AsGeoJSON(the_geom) AS the_geom, sequence, trips.from_id, trips.to_id, trip_id FROM trip_segments, trips WHERE trip_id = trips.id AND trips.test = 0 ORDER BY trip_id, sequence ASC', function(err, rows){
    if(err) console.log(err)
    
    let trips = [], trip = false, trip_id = false
    //Merge segments back into one trip / multilinestring
    for(let i in rows){
      if(rows[i].trip_id != trip_id){
        if(trip){
          trips.push(trip)
        }
        trip = {
          from:rows[i].from_id,
          to:rows[i].to_id,
          id:rows[i].trip_id,
          segments:[JSON.parse(rows[i].the_geom).coordinates]
        }
        trip_id = rows[i].trip_id
      }else{
        trip.segments.push((JSON.parse(rows[i].the_geom)).coordinates)
      }
    }    

    group_keys = {}, groups = []

    for(let i in trips){
      let id = trips[i].from + "_" + trips[i].to
      if(!(id in group_keys)){
        groups.push({
          from : trips[i].from,
          to : trips[i].to,
          connections: []
        })
        group_keys[id] = groups.length - 1
      }

      let mls = turf.multiLineString(trips[i].segments)
      mls.properties['id'] = trips[i].id
      groups[group_keys[id]].connections.push(mls)
    }

    let buffer = 0.300, overlap = 0.6, min_cluster = 0

    let cluster_groups = []

    groups.forEach( g => {
      let init_len = g.connections.length
      if(init_len > min_cluster){
        let clusters = [[g.connections[0]]]
        g.connections.splice(0,1)
        while(g.connections.length>=1){
          let matches = []
          let buffer_1 = turf.buffer(g.connections[0], buffer, 'kilometers'),
            area_1 = turf.area(buffer_1)
          for(let i = 0; i<clusters.length; i++){
            let intersect = false
            for(let j = 0; j<clusters[i].length; j++){
              let buffer_2 = turf.buffer(clusters[i][j], buffer, 'kilometers')
              
              let intersection = false
              try{
                //if polygons are too identical turf sometimes throws an error, for some reason adding a simplify to the loop fixes things...
                intersection = turf.intersect(buffer_1, buffer_2)
              }catch(err){
                buffer_1 = turf.simplify(buffer_1, 0.00001)
                buffer_2 = turf.simplify(buffer_2, 0.00001)
                try{
                  intersection = turf.intersect(buffer_1, buffer_2)
                }catch(err){
                  console.log('these two polygons don\'t like each other:')
                  console.log(JSON.stringify(buffer_1)+","+JSON.stringify(buffer_2))
                }
              }

              if(intersection){
                let area_2 = turf.area(buffer_2),
                  intersect_area = turf.area(intersection)
                if(intersect_area / area_2 > overlap && intersect_area / area_1 > overlap ){
                  intersect = true
                }
              }
            }
            if(intersect){
              matches.push(i)
            }
          }
          if(matches.length === 1){
            clusters[matches[0]].push(g.connections[0])
          }else if(matches.length > 1){
            clusters[matches[0]].push(g.connections[0])
            for(let i = 1; i<matches.length; i++){
              clusters[matches[0]] = clusters[matches[0]].concat(clusters[matches[i]])
            }
            for(let i = matches.length-1; i>0; i--){
              clusters.splice(matches[i], 1)
            }
          }else if(matches.length<1){
            clusters.push([g.connections[0]])
          }
          g.connections.splice(0,1)
        }

        cluster_groups.push({
          from: g.from,
          to: g.to,
          clusters:clusters
        })
      }
    })

    let corridors = []
    cluster_groups.forEach( (cluster, cluster_id) => {
      let features = []
      cluster.clusters.forEach(c => {
        buffers = [], trips = []
        c.forEach(l => {
          trips.push(l.properties.id)
          buffers.push(turf.buffer(l, buffer, 'kilometers'))
        })
        for(let b = 1; b<buffers.length; b++){
          try{
            buffers[0] = turf.union(buffers[0],buffers[b])
          }catch(err){
            buffers[b] = turf.simplify(buffers[b], 0.00001)
            buffers[0] = turf.union(buffers[0],buffers[b])
          }
        }
        buffers[0] = turf.simplify(buffers[0], 0.0001, true)
        buffers[0].properties['id'] = cluster_id
        buffers[0].properties['from'] = cluster.from
        buffers[0].properties['to'] = cluster.to
        buffers[0].properties['trips'] = trips
        corridors.push(buffers[0])
      })
    })

    fs.writeFileSync(dbname+'corridors.geojson',JSON.stringify(turf.featureCollection(corridors)))

    insert_corridors(corridors,0)
  })
}

function insert_corridors(corridors, i){
  let c = corridors[i]

  db.run("INSERT INTO corridors (from_id, to_id, the_geom) VALUES ("+c.properties.from+","+c.properties.to+", GeomFromText('POLYGON("+polygonToText(c.geometry.coordinates)+")', 4326))", function(err){
    if(err) console.log(err)    

    var corridor_id = this.lastID

    var trips_query = "";
    c.properties.trips.forEach( (t) => {
      trips_query += "INSERT INTO corridor_trips (corridor_id, trip_id) VALUES ("+corridor_id+","+t+");";
    })

    db.exec(trips_query, function(err){
      if(err) console.log(err)
      i++
      if(i<corridors.length){
        insert_corridors(corridors, i)
      }else{
        console.log('corridor_done',dev_diff())
        console.log('cluster_start',dev_diff())
        build_location_clusters()
      }
    })
  })
}

let cluster_dist = 0.5

function build_location_clusters(){
  db.all('SELECT from_id, to_id FROM trips GROUP BY from_id, to_id', function(err, rows){
    let edges = rows,
      edge_keys = {}

    edges.forEach( e => {
      if(!(e.from_id in edge_keys)){
        edge_keys[e.from_id] = []
      }
      edge_keys[e.from_id].push(e.to_id)
      if(!(e.to_id in edge_keys)){
        edge_keys[e.to_id] = []
      }
      edge_keys[e.to_id].push(e.from_id)
    })

    db.all('SELECT id, AsGeoJSON(the_geom) AS the_geom FROM locations', function(err, rows){

      let locations = rows,
        location_keys = {},
        cluster_keys = {},
        clusters_keys = {},
        clusters = [],
        cluster_count = 0

      locations.forEach( (l,li) => {
        l.the_geom = JSON.parse(l.the_geom)
        location_keys[l.id] = li
        cluster_keys[l.id] = false
      })

      rows.forEach(l => {
        if(l.id in edge_keys){
          edge_keys[l.id].forEach( e => {
            if((cluster_keys[l.id] && cluster_keys[e]) && cluster_keys[l.id] == cluster_keys[e] ){
              //They already belong to the same cluster
            }else{
              let dist = turf.distance(locations[location_keys[l.id]].the_geom, locations[location_keys[e]].the_geom, 'kilometers')
              if(dist < cluster_dist){
                if(cluster_keys[l.id] && cluster_keys[e]){
                  let key = cluster_keys[l.id],
                    alt_key = cluster_keys[e]
                  clusters_keys[alt_key].forEach( c => {
                    cluster_keys[c] = key
                    clusters_keys[key].push(c)
                  })
                  clusters_keys[alt_key] = []
                }else if(cluster_keys[l.id]){
                  let key = cluster_keys[l.id]
                  cluster_keys[e] = key
                  clusters_keys[key].push(e)
                }else if(cluster_keys[e]){
                  let key = cluster_keys[e]
                  cluster_keys[l.id] = key
                  clusters_keys[key].push(l.id)
                }else{
                  cluster_count++
                  let key = cluster_count
                  clusters_keys[key] = []
                  cluster_keys[l.id] = key
                  cluster_keys[e] = key
                  clusters_keys[key].push(e)
                  clusters_keys[key].push(l.id)
                }
              }
            }
          })
        }
      })

      for(let key in clusters_keys){
        let c = 0
        while(c<clusters_keys[key].length){
          if(c>0){
            for(var cc = c-1; cc>=0; cc--){
              if(clusters_keys[key][c] == clusters_keys[key][cc]){
                clusters_keys[key].splice(c,1)
                c--
              }
            }
          }
          c++
        }

        if(clusters_keys[key].length > 1){
          let children = []
          clusters_keys[key].forEach(c => {
            children.push({
              id:c,
              coordinate:locations[location_keys[c]].the_geom.coordinates
            })
          })
          clusters.push(children)
        }
      }

      insert_location_clusters(clusters, 0)
    })
  })
}

function insert_location_clusters(clusters, i){
  let c = clusters[i]
  
  db.run("INSERT INTO clusters (the_geom) VALUES (NULL)", function(err){
    if(err) console.log(err)

    var cluster_id = this.lastID

    var updates = ''
    c.forEach( (id, ci) => {
      updates += 'UPDATE locations SET cluster_id = '+cluster_id+' WHERE id = '+id.id+';'
      updates += 'UPDATE trips SET to_cluster = '+cluster_id+' WHERE to_id = '+id.id+';'
      updates += 'UPDATE trips SET from_cluster = '+cluster_id+' WHERE from_id = '+id.id+';'
      updates += 'UPDATE corridors SET to_cluster = '+cluster_id+' WHERE to_id = '+id.id+';'
      updates += 'UPDATE corridors SET from_cluster = '+cluster_id+' WHERE from_id = '+id.id+';'
    })

    db.exec(updates, function(err){
      if(err) console.log(err)

      //NOT SURE, WHY SPATIALITE CANNOT HANDLE 1-4 POINT HULLS?...
      let hull_command = "UPDATE clusters SET the_geom = Transform(CastToMulti(Buffer(Transform(ConcaveHull((SELECT ST_Collect(the_geom) FROM locations WHERE cluster_id = "+cluster_id+")), 3857),"+(cluster_dist*1000/2)+")), 4326) WHERE id = "+cluster_id
      if(c.length == 1){
        let buffer_geom = turf.buffer(turf.point(c[0].coordinate), cluster_dist/2)
        hull_command = "UPDATE clusters SET the_geom =  CastToMulti( GeomFromText('POLYGON("+polygonToText(buffer_geom.geometry.coordinates)+")' , 4326)) WHERE id = "+cluster_id
      }else if(c.length == 2){
        let buffer_geom = turf.buffer(turf.lineString([c[0].coordinate,c[1].coordinate]), cluster_dist/2)
        hull_command = "UPDATE clusters SET the_geom =  CastToMulti(GeomFromText('POLYGON("+polygonToText(buffer_geom.geometry.coordinates)+")' , 4326)) WHERE id = "+cluster_id
      }else if(c.length == 3 || c.length == 4){
        let cps = []
        c.forEach( cp => {
          cps.push(turf.point(cp.coordinate))
        })
        let buffer_geom = turf.buffer(turf.convex(turf.featureCollection(cps)), cluster_dist/2)
        hull_command = "UPDATE clusters SET the_geom =  CastToMulti(GeomFromText('POLYGON("+polygonToText(buffer_geom.geometry.coordinates)+")' , 4326)) WHERE id = "+cluster_id
      }

      db.run(hull_command, function(err){
        if(err) console.log(err)
        
        i++
        if(i<clusters.length){
          insert_location_clusters(clusters, i)
        }else{
          db.run("INSERT INTO cluster_locations (location_id, cluster_id) SELECT locations.id, clusters.id FROM clusters, locations WHERE Intersects(locations.the_geom, clusters.the_geom)", function(err){
            if(err) console.log(err)

            console.log('cluster_done',dev_diff())
            console.log('test_start',dev_diff())
            if(corr_test){
              setup_corr_test()
            }else{
              finish()
            }
          })
        }
      })
    })
  })
}

let test_cases = []

function setup_corr_test(){

  db.all("SELECT AsGeoJSON(the_geom) AS the_geom, duration, from_cluster, to_cluster, start_10_min, end_10_min, day_of_week, month, trip_id, trips.from_id, trips.to_id FROM trip_segments, trips WHERE trip_segments.trip_id = trips.id AND trip_id IN ("+test_trajectories.toString()+") ORDER BY trip_id, sequence ASC", function(err, rows){
    if(err) console.log(err)

    let c_trip_id = false, first = true, temp = {}
    rows.forEach(r => {
      if(r.trip_id != c_trip_id){
        c_trip_id = r.trip_id
        if(!first){
          test_cases.push(temp)
          temp = r
          temp.the_geom = JSON.parse(temp.the_geom)
        }else{
          first = false
        }
      }else{
        r.the_geom = JSON.parse(r.the_geom)
        temp.the_geom.coordinates = temp.the_geom.coordinates.concat(r.the_geom.coordinates)
      }
    })
    test_cases.push(temp)

    run_corr_test()
  })
}

let test_results = {hulls:[],tests:[]}, test_keys = {}

function run_corr_test(){
  let test_query = '', test_id = 1
  for(var ti = 1; ti<test_cases.length; ti++){
    let t = test_cases[ti]
    let c = t.the_geom.coordinates
    let dist = turf.lineDistance(turf.lineString(c),'kilometers')
    let test_dist = dist/(t.duration*5) 
    let test_points = [c[0]]
    let leftover = 0
    for(let i = 0; i<c.length-2; i++){
      let c_dist = turf.distance(turf.point(c[i]),turf.point(c[i+1]),'kilometers')
      if(leftover+c_dist < test_dist){
        leftover += c_dist
      }else{
        let t_dist = c_dist+leftover, lp = c[i]
        while(t_dist > test_dist){
          let l_dist = turf.distance(turf.point(lp),turf.point(c[i+1]),'kilometers'),
            part = (test_dist-leftover)/l_dist,
            px = lp[0] + (c[i+1][0]-lp[0])*part,
            py = lp[1] + (c[i+1][1]-lp[1])*part,
            p_dist = turf.distance(turf.point(lp),turf.point([px,py]),'kilometers')

          test_points.push([
            px,
            py
          ])

          lp = [px,py]
          t_dist -= (p_dist+leftover)
          leftover = 0
        }
        leftover = t_dist
      }
    }

    let result = {
      start:t.start_10_min,
      day_of_week:t.day_of_week,
      to:t.to_id,
      to_cluster:t.to_cluster,
      location:{
        to:t.to_id
      },
      cluster:{
        to:t.to_cluster
      },
      trajectory : c,
      points : test_points,
      tests: [],
      knns: {
        cluster:[],
        location:[]
      }
    }

    let points = result.points
    for(let pi = 1; pi<points.length; pi++){
      result.tests.push([])
      result.knns.cluster.push(false)
      result.knns.location.push(false)

      let linestring = []
      for(let i = 0; i<=pi; i++){
        linestring.push(points[i])
      }
      let poly = turf.buffer(turf.lineString(linestring), 0.3)
      test_query += "INSERT INTO temp_query (id, the_geom) VALUES ("+test_id+", GeomFromText('POLYGON("+polygonToText(poly.geometry.coordinates)+")', 4326));"
      test_keys[test_id] = {t:test_results.tests.length,p:pi-1}
      test_id++
    }

    test_results.tests.push(result)
  }

  db.exec(test_query, function(err){
    if(err) console.log(err)
    execute_corr_test()
  })
}

function execute_corr_test(){
  db.all("SELECT "+
    "temp_query.id AS temp_id, "+
    "corridors.id, "+
    "corridors.from_id, "+
    "corridors.to_id, "+
    "corridors.from_cluster, "+
    "corridors.to_cluster, "+
    //"COUNT(*) AS group_count, "+
    "group_concat(trips.start_10_min) AS t_start_10_min, "+
    "group_concat(trips.end_10_min) AS t_end_10_min, "+
    "group_concat(trips.day_of_week) AS t_day_of_week, "+
    "Area(Transform(Intersection(temp_query.the_geom, corridors.the_geom), 3857)) AS inter_area, "+
    "Area(Transform(temp_query.the_geom, 3857)) AS trip_area "+
    "FROM "+
    "temp_query, "+
    "corridors "+
    "LEFT JOIN corridor_trips ON corridors.id = corridor_trips.corridor_id "+
    "LEFT JOIN trips ON corridor_trips.trip_id = trips.id "+
    "WHERE "+
    " "+
    //70% overlap ... ?
    //"(Area(ST_Transform(Intersection(ST_Transform(Buffer(ST_Transform(GeomFromText('LINESTRING("+lineToText(linestring)+")' ,4326), 3857), 300), 4326), corridors.the_geom), 3857)) / Area(Buffer(ST_Transform(GeomFromText('LINESTRING("+lineToText(linestring)+")' ,4326), 3857), 300))) > 0.6 " +
    //Not enough overlaps
    "Intersects(temp_query.the_geom, corridors.the_geom) AND "+
    " (inter_area / trip_area) > 0.7 "+ //0.7?
    "GROUP BY "+
    "temp_query.id, corridors.id "+
    "ORDER BY temp_query.id, corridors.id ASC "+
    //"LIMIT 20"+ 
    "",
  function(err, rows){
    if(err) console.log(err)

    let corridor_ids = []
    rows.forEach(r => {
      corridor_ids.push(r.id)

      let key = test_keys[r.temp_id]

      let result = {
        id:r.id,
        intersect:r.inter_area/r.trip_area,
        location:{
          from:r.from_id,
          to:r.to_id
        },
        cluster:{
          from:r.from_cluster,
          to:r.to_cluster
        },
        events:[]
      }

      r.t_start_10_min = r.t_start_10_min.split(',')
      r.t_end_10_min = r.t_end_10_min.split(',')
      r.t_day_of_week = r.t_day_of_week.split(',')

      for(let ri = 0; ri<r.t_start_10_min.length; ri++){
        result.events.push({
          start:r.t_start_10_min[ri],
          end:r.t_end_10_min[ri],
          day_of_week:r.t_day_of_week[ri]
        })
      }

      test_results.tests[key.t].tests[key.p].push(result)
    })

    //Run knns on each result set
    for(var ti in test_results.tests){
      for(var pi in test_results.tests[ti].tests){
        if(test_results.tests[ti].tests[pi].length > 0){
          test_results.tests[ti].knns.location[pi] = getKnn(test_results.tests[ti].tests[pi], test_results.tests[ti], function(t){ return t.location.to })
          test_results.tests[ti].knns.cluster[pi] = getKnn(test_results.tests[ti].tests[pi], test_results.tests[ti], function(t){ return t.cluster.to }) 
        }
      }
    }

    db.all("SELECT "+
      "AsGeoJSON(the_geom) AS the_geom, id "+
      "FROM "+
      "corridors "+
      "WHERE "+
      "id IN ("+corridor_ids.toString()+")",
    function(err, rows){
      rows.forEach(r => {
        test_results.hulls[r.id] = JSON.parse(r.the_geom)
      })

      db.exec('DELETE FROM temp_query', function(err){
        if(err) console.log(err)
        fs.writeFileSync(dbname+'knn_test_results.json', JSON.stringify(test_results, null, "\t"))
        networkAnalysis()
      })
    })
  })
}

function getKnn(result_test, result, rFunc){
  //Check which of the events is the most likely to match, based on temporal features
  let items = []
  result_test.forEach( (t) => {
    t.events.forEach( e => {
      if(e){
        //in order to account for breaks between 144/0 and 6/0 the sets are shifted
        items.push({
          start:shiftNumber(e.start,result.start,144,0),
          day_of_week:shiftNumber(e.day_of_week,result.day_of_week,6,0),
          intersect:t.intersect,
          output:rFunc(t)
        })
      }
    })
  })

  options = {
    //k:20,
    //debug:true,
    weights: {
      intersect: 0.1,
      start: 0.05,
      day_of_week: 0.01
    }
  }

  let knns = knn({start: result.start, day_of_week: result.day_of_week, intersect:1 }, items, options)

  let t_knns = {}
  knns.forEach((k,ki) => {
    if(!(k.output in t_knns)){
      t_knns[k.output] = 0
    }
    //Maybe not smart?
    t_knns[k.output] += (knns.length-ki)
  })

  //reorder
  let ta_knns = []
  for(let key in t_knns){
    ta_knns.push({id:key, c:t_knns[key]})
  }
  //DESC
  ta_knns.sort((a,b) => {
    if (a.c < b.c) {
      return 1
    }else if (a.c > b.c) {
      return -1
    }else{
      return 0
    }
  })

  return ta_knns
}

function shiftNumber(target,ref,max,min){
  if(min==0){max+=1}
  if(target > ref+max/2){
    return target-max
  }else if(target < ref-max/2){
    return max-target+max/2-(max-ref)+1
  }else{
    return target
  }
}

function networkAnalysis(){

  let max_edge = 0, locations = {}, added = {}

  db.all('SELECT from_id, to_id FROM trips', function(err, rows){
    if(err) console.log(err)

    rows.forEach( r => {
      ngraph.addLink(r.from_id, r.to_id);
    })

    let dc = ng_centrality.degree(ngraph),
      dc_in = ng_centrality.degree(ngraph, 'in'),
      dc_out = ng_centrality.degree(ngraph, 'out'),
      bc = ng_centrality.betweenness(ngraph, true),
      pg = ng_pagerank(ngraph),
      cw = ng_cw(ngraph),
      slpa = ng_slpa(ngraph),
      louvain = ng_louvain(ngraph),
      hits = ng_hits(ngraph)

    let requiredChangeRate = 0; // 0 is complete convergence
    while (cw.getChangeRate() > requiredChangeRate) {
      cw.step();
    }

    /*
    while(clusters.canCoarse()) {
      graph = coarsen(graph, clusters);
      clusters = detectClusters(graph);
      // this will give you next level in the hierarchy
    }
    */

    let update_query = ''
    ngraph.forEachNode( node => {
      
      update_query += "UPDATE locations SET "+
        "dc = "+dc[node.id]+
        ", dc_in = "+dc_in[node.id]+
        ", dc_out = "+dc_in[node.id]+
        ", bc = "+bc[node.id]+
        ", pagerank = "+pg[node.id]+
        ", h_authority = "+hits[node.id].authority+
        ", h_hub = "+hits[node.id].hub+
        ", louvain = "+louvain.getClass(node.id)+
        ", cw = "+cw.getClass(node.id)+
        " WHERE id = "+node.id+";"

      slpa.nodes[node.id].forEach( s => {
        update_query += "INSERT INTO location_slpa (location_id, name, probability) VALUES ("+node.id+",'"+s.name+"',"+s.probability+");"
      })
    })

    db.exec(update_query, function(err){
      if(err) console.log(err)
      console.log('test_done',dev_diff())
      getClusters()
    })

  })
}

function getClusters(){
  db.all('SELECT AsGeoJSON(the_geom) AS the_geom, id FROM clusters', function(err, rows){
    if(err) console.log(err)

    var features = []
    rows.forEach(r => {
      if(r.the_geom != null){
        features.push({type:'Feature',properties:{},geometry:JSON.parse(r.the_geom)})
      }
    })

    fs.writeFileSync(dbname+'cluster.geojson', JSON.stringify(turf.featureCollection(features)))
    finish()
  })
}

function lineToText(line){
  var text = ''
  let i = 0
  line.forEach((c) => {
    if( Object.prototype.toString.call( c ) === '[object Array]' ) {
      if(i>0){
        text += ','
      }
      text += c[0]+' '+c[1]
      i++
    }
  })
  return text
}

function polygonToText(poly){
  var text = ''
  poly.forEach( (p,i) => {
    if(i>0){
      text += ','
    }
    text += '('
    p.forEach( (c,ii) => {
      if(ii>0){
        text += ','
      }
      text += c[0]+' '+c[1]
    })
    text += ')'
  })
  return text
}

//Some trajectories are really bad formatted, this includes several functions which are trying to cope with those problems
function validateLine(line, activity){
  /*let threshold = training[activity].iqr[1],
    median = training[activity].iqr[1];

  for(let i = 1; i<line.length-1; i++){
    switch(i){
      //special check if start-point is off
      case 1:
        let dist_1 = turf.distance(turf.point(line[0]), turf.point(line[1]))
        let dist_2 = turf.distance(turf.point(line[1]), turf.point(line[2]))
        if(dist_1 < threshold && dist_2 < threshold){
          //all good
        }else if(dist_1 > threshold && dist_2 > threshold){

        }
      break;
      //special check if end-point is off
      case line.length-2:

      break;
      //others in between
      case default:
      break;
    }
  }
  */
  return line
}

function optimizePoint(p1,p2,p3,median,threshold){
  /*//first try, take the direction of the line and reduce it to the median

  //first calculate a complete triangle 1=A, 2=B, 3=C
  let a = turf.distance(turf.point(p3),turf.point(p2)), 
    am = (a+median)/2,
    b = turf.distance(turf.point(p3),turf.point(p1)), 
    c = turf.distance(turf.point(p2),turf.point(p1)),
    cm = (c+median)/2

  if(am+cm < b){
    if(a+c > b*1.2){
      p2[0] = p1[0] + (p3[0]-p1[0])/2
      p2[1] = p1[1] + (p3[1]-p1[1])/2
    }
  }else{
    let angle_3 = Math.acos((Math.pow(am,2)+Math.pow(b,2)-Math.pow(cm,2))/(2*am*b)),
      angle_1 = Math.acos((Math.pow(b,2)+Math.pow(cm,2)-Math.pow(am,2))/(2*b*cm)),
      angle_2 = Math.acos((Math.pow(cm,2)+Math.pow(am,2)-Math.pow(b,2))/(2*c*am)),
      hf = (c/Math.sin(angle_3)) * Math.sin(angle_2),
      hp = [p1[0] + (hf/b * (p3[0]-p1[0])), p1[1] + (hf/b * (p3[1]-p1[1]))],
      h = Math.sqrt(Math.pow(c,2)-Math.pow(hf,2)),
      hv = [p3[1]-p1[1], p3[0]-p1[0]]


  } 

  return p2*/
}

function finish(){
  console.log('done');
  db.close();
  process.exit()
}

function tableExists(name, callback){
  db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=$name;", { $name: name }, callback);
}