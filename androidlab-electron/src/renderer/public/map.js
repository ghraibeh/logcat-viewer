/*
 * Map guest script — ported from logcat_viewer/assets/map.html's inline script.
 * Kept in a separate file (not inline) so the guest CSP can be script-src 'self'
 * with no 'unsafe-inline'. maplibre-gl is vendored locally (../maplibre-gl.js).
 *
 * host <-> guest bridge (faithful analogue of the Qt document.title bridge):
 *   guest -> host: a picked coordinate is encoded into document.title as
 *                  "MOCKLOC:lat,lng|seq" (host reads it via page-title-updated);
 *                  the map-ready signal is "MAPLOADED:ok" / "MAPLOADED:err".
 *   host  -> guest: window.setLocation(lat, lng, recenter) moves the pin without
 *                   firing a notify() back (avoids feedback loops while typing).
 */
/* global maplibregl */
(function () {
  'use strict'

  // --- guest -> host ---------------------------------------------------------
  let _seq = 0
  function notify(lat, lng) {
    document.title = 'MOCKLOC:' + lat.toFixed(7) + ',' + lng.toFixed(7) + '|' + _seq++
  }
  function signalMapLoaded(ok) {
    document.title = ok ? 'MAPLOADED:ok' : 'MAPLOADED:err'
  }
  function updateReadout(lat, lng) {
    document.getElementById('readout').innerHTML =
      '<b>' + lat.toFixed(6) + ', ' + lng.toFixed(6) + '</b>'
  }

  let map, marker
  const OSM_STYLE = {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: [
          'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png'
        ],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors'
      }
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
  }

  try {
    map = new maplibregl.Map({
      container: 'map',
      style: OSM_STYLE,
      center: [0, 20],
      zoom: 1.4,
      attributionControl: { compact: true }
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')

    marker = new maplibregl.Marker({ color: '#e2554e', draggable: true }).setLngLat([0, 20]).addTo(map)

    marker.on('dragend', function () {
      const p = marker.getLngLat()
      updateReadout(p.lat, p.lng)
      notify(p.lat, p.lng)
    })
    marker.on('drag', function () {
      const p = marker.getLngLat()
      updateReadout(p.lat, p.lng)
    })

    map.on('click', function (e) {
      marker.setLngLat(e.lngLat)
      updateReadout(e.lngLat.lat, e.lngLat.lng)
      notify(e.lngLat.lat, e.lngLat.lng)
    })

    map.on('load', function () {
      signalMapLoaded(true)
      const h = document.getElementById('hint')
      setTimeout(function () {
        h.style.opacity = '0'
      }, 3500)
    })
    map.on('error', function (e) {
      console.error('map error', e && e.error)
    })
  } catch (e) {
    document.getElementById('err').style.display = 'grid'
    signalMapLoaded(false)
    console.error(e)
  }

  // --- place-name search (Nominatim / OpenStreetMap) -------------------------
  const searchBox = document.getElementById('search')
  searchBox.addEventListener('keydown', async function (ev) {
    if (ev.key !== 'Enter') return
    const q = searchBox.value.trim()
    if (!q) return
    searchBox.blur()
    try {
      const url =
        'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q)
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } })
      const hits = await res.json()
      if (!hits || !hits.length) {
        searchBox.value = ''
        searchBox.placeholder = 'No match — try another place'
        return
      }
      const lat = parseFloat(hits[0].lat)
      const lng = parseFloat(hits[0].lon)
      marker.setLngLat([lng, lat])
      updateReadout(lat, lng)
      map.flyTo({ center: [lng, lat], zoom: 13, speed: 1.8 })
      notify(lat, lng) // adopt the found place as the selected coordinate
    } catch (e) {
      searchBox.placeholder = 'Search failed (offline?)'
      console.error(e)
    }
  })

  // --- host -> guest ---------------------------------------------------------
  window.setLocation = function (lat, lng, recenter) {
    if (!map || !marker) return
    marker.setLngLat([lng, lat])
    updateReadout(lat, lng)
    if (recenter) {
      map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 13), speed: 1.6 })
    }
  }
})()
