/* =====================================================
   DATA — Static reference data only
   No simulation. Ships use ocean lane positions as
   starting points; movement is minimal/decorative.
   All real tracking data comes via api.js
===================================================== */

var Data = (function() {

  var jammingZones = [
    { lat: 33.3, lon: 44.4, radius: 0.08, intensity: 0.9, label: 'Baghdad', type: 'combat' },
    { lat: 35.0, lon: 36.2, radius: 0.07, intensity: 0.7, label: 'N.Syria', type: 'combat' },
    { lat: 31.5, lon: 34.5, radius: 0.06, intensity: 0.8, label: 'Gaza', type: 'combat' },
    { lat: 52.1, lon: 37.0, radius: 0.05, intensity: 0.5, label: 'Belgorod', type: 'border' },
    { lat: 54.7, lon: 20.5, radius: 0.09, intensity: 0.8, label: 'Kaliningrad', type: 'strat' },
  ];

  // Realistic ship positions on actual ocean trade lanes
  // These are static anchors — ships do a very slow drift (decorative)
  var SHIP_ANCHORS = [
    { name: 'EVER GIVEN 1',         lat: 30.5,  lon: 32.5  }, // Suez
    { name: 'MAERSK ESSEX 2',       lat: 51.2,  lon:  3.1  }, // English Channel
    { name: 'MSC ANNA 3',           lat: 35.8,  lon: 14.2  }, // Mediterranean
    { name: 'OOCL FRANCE 4',        lat:  1.3,  lon: 104.0 }, // Malacca
    { name: 'CMA CGM POLO 5',       lat: 24.5,  lon: 57.0  }, // Hormuz
    { name: 'COSCO PACIFIC 6',      lat: 38.0,  lon:-72.0  }, // N.Atlantic
    { name: 'NYK TIGER 7',          lat: 34.5,  lon:139.5  }, // Tokyo Bay
    { name: 'MOL TRIUMPH 8',        lat:-33.9,  lon: 25.6  }, // Cape
    { name: 'HMM ALGECIRAS 9',      lat: 36.1,  lon: -5.4  }, // Gibraltar
    { name: 'CSCL GLOBE 10',        lat: 22.3,  lon:114.2  }, // Hong Kong
    { name: 'EVER GLORY 11',        lat: 43.5,  lon:-63.0  }, // Halifax
    { name: 'MAERSK MC-KINNEY 12',  lat: 55.6,  lon:  8.4  }, // North Sea
    { name: 'MSC OSCAR 13',         lat:-23.0,  lon:-43.5  }, // Rio
    { name: 'OOCL HONG KONG 14',    lat: 10.5,  lon: 64.0  }, // Arabian Sea
    { name: 'CMA CGM JULES 15',     lat:-15.0,  lon: 40.0  }, // Mozambique
    { name: 'COSCO SHIPPING 16',    lat: 13.5,  lon: 43.5  }, // Red Sea
    { name: 'EVER ACE 17',          lat: 49.5,  lon:-128.0 }, // N.Pacific
    { name: 'HYUNDAI PRIDE 18',     lat:-38.0,  lon:-57.0  }, // S.Atlantic
    { name: 'YANG MING 19',         lat:  4.0,  lon: 80.0  }, // Indian Ocean
    { name: 'ZIM INTEGRATED 20',    lat: 32.1,  lon: 34.8  }, // Tel Aviv
  ];

  function generateShips() {
    return SHIP_ANCHORS.map(function(a, i) {
      return {
        id:    i,
        name:  a.name,
        lat:   a.lat + (Math.random() - 0.5) * 0.5,
        lon:   a.lon + (Math.random() - 0.5) * 0.5,
        speed: 8 + Math.random() * 12,
        // Very slow decorative drift — ~1-2 knots worth
        dlat:  (Math.random() - 0.5) * 0.00008,
        dlon:  (Math.random() - 0.5) * 0.00012,
      };
    });
  }

  // Ships only — tick just moves them slightly
  function tick(ships) {
    ships.forEach(function(s) {
      s.lat += s.dlat;
      s.lon += s.dlon;
      if (s.lat >  75) s.dlat = -Math.abs(s.dlat);
      if (s.lat < -60) s.dlat =  Math.abs(s.dlat);
      if (s.lon >  180) s.lon = -180;
      if (s.lon < -180) s.lon =  180;
    });
  }

  return { jammingZones, generateShips, tick };

}());
