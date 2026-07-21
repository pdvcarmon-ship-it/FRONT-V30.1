'use client'

import { useEffect, useRef } from 'react'

interface Props {
  onParcelaClick: (lat: number, lon: number) => void
  onParcelasDibujadas: (geojson: any, supHa: number) => void
  parcGeojson: any
  imagenUrl: string | null
  indiceColor: string
  parcelaVistaColor?: string
  seleccionando: boolean
  mododibujo: boolean
  onMododibujoCambiado: (activo: boolean) => void
}

export default function MapView({
  onParcelaClick, onParcelasDibujadas,
  parcGeojson, imagenUrl, indiceColor, parcelaVistaColor,
  seleccionando, mododibujo, onMododibujoCambiado
}: Props) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<any>(null)
  const parcelaLayerRef = useRef<any>(null)
  const imagenLayerRef = useRef<any>(null)
  const clickHandlerRef = useRef<any>(null)
  const drawnLayersRef = useRef<any>(null)
  const drawControlRef = useRef<any>(null)
  const dibujandoRef = useRef(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !mapRef.current || mapInstanceRef.current) return
    const L = require('leaflet')
    require('leaflet/dist/leaflet.css')

    const map = L.map(mapRef.current, { center: [40.0, -3.5], zoom: 6, zoomControl: false })

    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: '© Esri, Maxar, Earthstar Geographics', maxZoom: 20 }
    ).addTo(map)

    L.tileLayer.wms('https://sigpac-hubcloud.es/wms', {
      layers: 'recintos', format: 'image/png', transparent: true,
      version: '1.3.0', opacity: 0.55, attribution: '© FEGA SIGPAC', maxZoom: 20,
    }).addTo(map)

    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      { attribution: '', maxZoom: 20, opacity: 0.7 }
    ).addTo(map)

    L.control.zoom({ position: 'bottomright' }).addTo(map)
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map)

    // Botón geolocalización
    const GeoControl = L.Control.extend({
      onAdd: () => {
        const btn = L.DomUtil.create('button', '')
        btn.innerHTML = '📍'
        btn.title = 'Mi ubicación'
        btn.style.cssText = 'background:rgba(15,26,18,0.92);border:1px solid #1e3322;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:16px;color:#d4f0dc;width:34px;height:34px;display:flex;align-items:center;justify-content:center;'
        btn.onclick = (e: MouseEvent) => {
          L.DomEvent.stopPropagation(e)
          if (!navigator.geolocation) { alert('Tu navegador no soporta geolocalización'); return }
          btn.innerHTML = '⏳'
          navigator.geolocation.getCurrentPosition(
            (pos) => { map.setView([pos.coords.latitude, pos.coords.longitude], 17); btn.innerHTML = '📍' },
            (err) => { alert('No se pudo obtener la ubicación: ' + err.message); btn.innerHTML = '📍' },
            { enableHighAccuracy: true, timeout: 10000 }
          )
        }
        return btn
      }
    })
    new GeoControl({ position: 'bottomright' }).addTo(map)

    // Grupo de capas dibujadas
    const drawnLayers = new L.FeatureGroup().addTo(map)
    drawnLayersRef.current = drawnLayers

    mapInstanceRef.current = map
  }, [])

  // Modo dibujo: activar/desactivar herramienta de polígono
  useEffect(() => {
    const map = mapInstanceRef.current
    const drawnLayers = drawnLayersRef.current
    if (!map || !drawnLayers) return

    const L = require('leaflet')

    if (mododibujo && !dibujandoRef.current) {
      dibujandoRef.current = true

      // Cargar leaflet-draw dinámicamente
      if (!(L as any).Draw) {
        const script = document.createElement('script')
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.js'
        script.onload = () => {
          const link = document.createElement('link')
          link.rel = 'stylesheet'
          link.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.css'
          document.head.appendChild(link)
          iniciarDibujo(map, L, drawnLayers)
        }
        document.head.appendChild(script)
      } else {
        iniciarDibujo(map, L, drawnLayers)
      }
    } else if (!mododibujo) {
      dibujandoRef.current = false
      // Limpiar handler de draw
      if (drawControlRef.current) {
        try { map.removeControl(drawControlRef.current) } catch {}
        drawControlRef.current = null
      }
    }
  }, [mododibujo])

  const iniciarDibujo = (map: any, L: any, drawnLayers: any) => {
    // Limpiar polígonos anteriores
    drawnLayers.clearLayers()

    // Iniciar herramienta de polígono directamente
    const drawHandler = new (L as any).Draw.Polygon(map, {
      shapeOptions: {
        color: '#3ddc6e',
        weight: 2,
        fillColor: '#3ddc6e',
        fillOpacity: 0.15,
        dashArray: '6 3',
      },
      showArea: true,
      metric: true,
    })
    drawHandler.enable()
    drawControlRef.current = drawHandler

    // Cuando se completa un polígono
    map.once((L as any).Draw.Event.CREATED, (e: any) => {
      const layer = e.layer
      drawnLayers.addLayer(layer)

      // Botón para añadir otro polígono o confirmar
      mostrarOpcionesDibujo(map, L, drawnLayers)
    })
  }

  const mostrarOpcionesDibujo = (map: any, L: any, drawnLayers: any) => {
    // Crear popup con opciones
    const center = map.getCenter()

    const ConfirmControl = L.Control.extend({
      onAdd: () => {
        const div = L.DomUtil.create('div', '')
        div.style.cssText = 'background:rgba(15,26,18,0.95);border:1px solid #1e3322;border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px;min-width:180px;'

        div.innerHTML = `
          <div style="font-family:'Space Mono',monospace;font-size:10px;color:#4a7a56;margin-bottom:4px;letter-spacing:0.06em;">POLÍGONO DIBUJADO</div>
          <button id="btn-mas" style="background:rgba(77,184,255,0.1);border:1px solid #4db8ff;border-radius:5px;padding:6px 10px;color:#4db8ff;font-family:'Space Mono',monospace;font-size:11px;cursor:pointer;">+ Añadir otro polígono</button>
          <button id="btn-confirmar" style="background:#3ddc6e;border:none;border-radius:5px;padding:6px 10px;color:#080c0a;font-family:'Space Mono',monospace;font-size:11px;font-weight:700;cursor:pointer;">✓ Confirmar selección</button>
          <button id="btn-borrar" style="background:rgba(255,107,107,0.1);border:1px solid #ff6b6b;border-radius:5px;padding:6px 10px;color:#ff6b6b;font-family:'Space Mono',monospace;font-size:11px;cursor:pointer;">✕ Borrar y repetir</button>
        `

        L.DomEvent.disableClickPropagation(div)

        setTimeout(() => {
          div.querySelector('#btn-mas')?.addEventListener('click', () => {
            map.removeControl(confirmControl)
            // Dibujar otro polígono
            const drawHandler = new (L as any).Draw.Polygon(map, {
              shapeOptions: { color: '#4db8ff', weight: 2, fillColor: '#4db8ff', fillOpacity: 0.15, dashArray: '6 3' },
            })
            drawHandler.enable()
            map.once((L as any).Draw.Event.CREATED, (e: any) => {
              drawnLayers.addLayer(e.layer)
              mostrarOpcionesDibujo(map, L, drawnLayers)
            })
          })

          div.querySelector('#btn-confirmar')?.addEventListener('click', () => {
            map.removeControl(confirmControl)
            confirmarPoligonos(L, drawnLayers)
          })

          div.querySelector('#btn-borrar')?.addEventListener('click', () => {
            map.removeControl(confirmControl)
            drawnLayers.clearLayers()
            iniciarDibujo(map, L, drawnLayers)
          })
        }, 100)

        return div
      }
    })

    const confirmControl = new ConfirmControl({ position: 'topleft' })
    confirmControl.addTo(map)
    drawControlRef.current = confirmControl
  }

  const confirmarPoligonos = (L: any, drawnLayers: any) => {
    const layers: any[] = []
    drawnLayers.eachLayer((layer: any) => layers.push(layer))

    if (layers.length === 0) return

    // Unir todos los polígonos en un MultiPolygon o Polygon
    const features = layers.map(layer => layer.toGeoJSON())

    let geojson: any
    if (features.length === 1) {
      // Un solo polígono
      geojson = { type: 'FeatureCollection', features: [features[0]] }
    } else {
      // Varios polígonos → MultiPolygon
      const coordinates = features.map(f =>
        f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates[0]
      )
      geojson = {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: { type: 'MultiPolygon', coordinates: coordinates.map(c => [c[0]]) },
          properties: { origen: 'dibujado_mano' }
        }]
      }
    }

    // Calcular superficie aproximada
    let supHa = 0
    features.forEach(f => {
      const coords = f.geometry.type === 'Polygon'
        ? f.geometry.coordinates[0]
        : f.geometry.coordinates[0][0]
      supHa += calcularAreaHa(coords)
    })

    onParcelasDibujadas(geojson, supHa)
    onMododibujoCambiado(false)
    drawnLayers.clearLayers()
  }

  const calcularAreaHa = (coords: number[][]): number => {
    // Fórmula de Shoelace en coordenadas geográficas aproximadas
    if (coords.length < 3) return 0
    const lat0 = coords[0][1]
    const mPerDegLat = 111320
    const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180)
    let area = 0
    for (let i = 0; i < coords.length - 1; i++) {
      const x1 = coords[i][0] * mPerDegLon
      const y1 = coords[i][1] * mPerDegLat
      const x2 = coords[i + 1][0] * mPerDegLon
      const y2 = coords[i + 1][1] * mPerDegLat
      area += x1 * y2 - x2 * y1
    }
    return Math.abs(area) / 2 / 10000 // m² → ha
  }

  // Click en mapa para seleccionar parcela SIGPAC
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return
    const container = map.getContainer()
    if (clickHandlerRef.current) map.off('click', clickHandlerRef.current)

    if (seleccionando) {
      container.classList.add('selecting')
      const handler = (e: any) => onParcelaClick(e.latlng.lat, e.latlng.lng)
      clickHandlerRef.current = handler
      map.on('click', handler)
    } else {
      container.classList.remove('selecting')
      clickHandlerRef.current = null
    }
  }, [seleccionando, onParcelaClick])

  // Dibuja contorno de parcela seleccionada
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return
    const L = require('leaflet')
    if (parcelaLayerRef.current) { map.removeLayer(parcelaLayerRef.current); parcelaLayerRef.current = null }
    if (!parcGeojson) return

    const borderColor = parcelaVistaColor || indiceColor
    const layer = L.geoJSON(parcGeojson, {
      style: {
        color: borderColor,
        weight: parcelaVistaColor ? 2 : 3,
        fillColor: parcelaVistaColor ? 'transparent' : indiceColor,
        fillOpacity: parcelaVistaColor ? 0 : 0.12,
        dashArray: '6 3'
      }
    }).addTo(map)
    parcelaLayerRef.current = layer
    try { map.fitBounds(layer.getBounds(), { padding: [60, 60], maxZoom: 18 }) } catch {}
  }, [parcGeojson, indiceColor])

  // Overlay imagen NDVI
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return
    const L = require('leaflet')
    if (imagenLayerRef.current) { map.removeLayer(imagenLayerRef.current); imagenLayerRef.current = null }
    if (!imagenUrl || !parcGeojson?.features?.length) return

    const geom = parcGeojson.features[0].geometry
    const allCoords: number[][] = []
    if (geom.type === 'Polygon') allCoords.push(...geom.coordinates[0])
    else if (geom.type === 'MultiPolygon') geom.coordinates.forEach((p: any) => allCoords.push(...p[0]))
    if (!allCoords.length) return

    const lons = allCoords.map(c => c[0])
    const lats = allCoords.map(c => c[1])
    const bounds: [[number, number], [number, number]] = [
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)],
    ]
    imagenLayerRef.current = L.imageOverlay(imagenUrl, bounds, { opacity: 0.85 }).addTo(map)
  }, [imagenUrl, parcGeojson])

  return <div ref={mapRef} style={{ width: '100%', height: '100%' }} />
}
