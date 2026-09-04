'use client'

import { useEffect, useRef } from 'react'

interface ParcelaRef {
  id: string
  nombre: string
  geojson: any
}

interface Props {
  parcelas: ParcelaRef[]
  punto: { lat: number; lng: number } | null
  onPuntoSeleccionado: (lat: number, lng: number) => void
}

// Mapa ligero e independiente del MapView principal — solo sirve para que el usuario marque
// un punto (pozo, canal...) dentro de los límites aproximados de una finca. Dibuja las
// parcelas de la finca como referencia visual y coloca un marcador en el punto elegido.
export default function UbicacionMapModal({ parcelas, punto, onPuntoSeleccionado }: Props) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<any>(null)
  const parcelasLayerRef = useRef<any>(null)
  const markerRef = useRef<any>(null)
  const onPuntoSeleccionadoRef = useRef(onPuntoSeleccionado)

  useEffect(() => { onPuntoSeleccionadoRef.current = onPuntoSeleccionado }, [onPuntoSeleccionado])

  useEffect(() => {
    if (typeof window === 'undefined' || !mapRef.current || mapInstanceRef.current) return
    const L = require('leaflet')
    require('leaflet/dist/leaflet.css')

    const map = L.map(mapRef.current, { center: [40.0, -3.5], zoom: 6, zoomControl: false })
    if ((map as any).tap) (map as any).tap.disable()

    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: '© Esri, Maxar, Earthstar Geographics', maxZoom: 20 }
    ).addTo(map)

    L.control.zoom({ position: 'bottomright' }).addTo(map)

    map.on('click', (e: any) => onPuntoSeleccionadoRef.current(e.latlng.lat, e.latlng.lng))

    mapInstanceRef.current = map
    return () => { try { map.remove() } catch {}; mapInstanceRef.current = null }
  }, [])

  // Dibuja las parcelas de la finca como referencia y encuadra el mapa
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return
    const L = require('leaflet')
    if (parcelasLayerRef.current) { map.removeLayer(parcelasLayerRef.current); parcelasLayerRef.current = null }
    if (!parcelas || parcelas.length === 0) return

    const grupo = L.featureGroup()
    parcelas.forEach(p => {
      if (!p.geojson) return
      const capa = L.geoJSON(p.geojson, {
        style: { color: '#3ddc6e', weight: 2, fillColor: '#3ddc6e', fillOpacity: 0.1 },
      }).addTo(grupo)
      if (p.nombre) capa.bindTooltip(p.nombre, { direction: 'center', className: 'kampo-etiqueta-pieza' })
    })
    grupo.addTo(map)
    parcelasLayerRef.current = grupo
    try { map.fitBounds(grupo.getBounds(), { padding: [50, 50], maxZoom: 18 }) } catch {}
  }, [parcelas])

  // Dibuja/actualiza el marcador del punto seleccionado
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return
    const L = require('leaflet')
    if (markerRef.current) { map.removeLayer(markerRef.current); markerRef.current = null }
    if (!punto) return
    const marker = L.circleMarker([punto.lat, punto.lng], {
      radius: 9, color: '#ff6b6b', weight: 3, fillColor: '#ff6b6b', fillOpacity: 0.75,
    }).addTo(map)
    markerRef.current = marker
  }, [punto])

  return <div ref={mapRef} style={{ width: '100%', height: '100%' }} />
}
