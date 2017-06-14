let fs = require('fs'),
    sql = require('spatialite')

var db = new sql.Database(process.argv[2]+'.db', function(err){
  if(err) console.log(err);

  db.spatialite(function(err) {
    if(err) console.log(err);

    db.all(process.argv[3], function(err, rows){
      if(err){
        console.log('ERROR:', err)
      }else{
        if(process.argv[4] == 'TRUE'){
          fs.writeFileSync(process.argv[3]+'.json', JSON.stringify(rows, null, "\t"))
        }else{
          console.log(JSON.stringify(rows))
        }
      }
    })
  })
})