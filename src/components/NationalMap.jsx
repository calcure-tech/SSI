import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, GeoJSON } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import rawGeo from '../data/sigungu_geo.json'
// 63차 — 주변국 땅(북한·중국·일본·러시아 일부). Natural Earth 10m 경계를 한반도 주변으로
// 자르고 단순화해 파일 안에 넣었다. 외부 배경지도 없이도 한반도가 섬처럼 떠 보이지 않게.
import neighborGeo from '../data/neighbors_geo.json'

const NB_STYLE = { fillColor: '#EEEBE4', fillOpacity: 1, color: '#BCC3CC', weight: 0.7, opacity: 1 }
// 그려 둔 범위(주변국 해안선을 자른 사각형). 이 밖은 비어 있으므로 화면이 넘어가지 않게 막는다.
const DRAWN = L.latLngBounds([31.3, 119.5], [41.2, 135.5])
const NB_LABELS = [['북한', 38.6, 126.45], ['중국', 37.0, 121.2], ['일본', 33.75, 131.1]]
import { ROWS, rowKey, keyOf, rowIndex, valuesOf, shortSido, SECTORS, HEAT, BLUE, GREEN, DIV, PURPLE, methodOf, indsOf } from '../lib/ssi.js'
import { HueDots } from './ResultChrome.jsx'
import { Plus, Minus, Reset, Expand, Download } from './Glyph.jsx'
import { CLASS_MODES, modeOf, breaksOf, classOf, autoMode, autoReason } from '../lib/classify.js'
import { exportShapefile, exportGeoJSON, exportCSV } from '../lib/shpout.js'

const okRing = (r) => Array.isArray(r) && r.length >= 4 &&
  r.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
function cleanGeometry(g) {
  if (!g) return null
  if (g.type === 'Polygon') { const rings = (g.coordinates || []).filter(okRing); return rings.length ? { type: 'Polygon', coordinates: rings } : null }
  if (g.type === 'MultiPolygon') { const polys = (g.coordinates || []).map((p) => (p || []).filter(okRing)).filter((p) => p.length); return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null }
  return null
}
export const featKey = (f) => keyOf(f.properties?.sido, f.properties?.name)

let GEO = null
export function geoData() {
  if (!GEO) GEO = {
    type: 'FeatureCollection',
    features: (rawGeo.features || []).map((f) => ({ ...f, geometry: cleanGeometry(f.geometry) })).filter((f) => f.geometry),
  }
  return GEO
}
const RAMP = { heat: HEAT, blue: BLUE, green: GREEN, rank: BLUE, div: DIV }
// 사용자가 고른 지도 색(40차) — 값 종류가 정하는 기본 색을 덮어쓴다.
// 순위 지도의 '1위가 진하게' 뒤집기나 범례 글은 그대로 두고, 색만 갈아 끼운다.
export const HUES = { blue: BLUE, green: GREEN, heat: HEAT, purple: PURPLE }

/* ── 이름표 자리 잡기 ───────────────────────────────────────────────────
   시군구 이름을 지도 위에 직접 얹는다. 말풍선은 마우스를 올려야 보이니,
   인쇄하거나 화면을 갈무리했을 때 어디가 어딘지 알 수 없기 때문이다.

   자리는 '가장 넓은 조각의 무게중심'이다. 섬이 딸린 시군구는 본섬 위에 붙는다.
   넓이 순으로 놓되 이미 놓인 이름표와 겹치면 건너뛴다. 확대할수록 자리가
   넓어지므로, 같은 규칙만으로도 멀리서는 큰 지역만 · 가까이서는 전부 보인다. */
function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1]
    const f = x0 * y1 - x1 * y0
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f
  }
  a /= 2
  if (!a) return null
  return { x: cx / (6 * a), y: cy / (6 * a), a: Math.abs(a) }
}

let LABS = null
function labelData() {
  if (LABS) return LABS
  const sgg = []
  geoData().features.forEach((f) => {
    const g = f.geometry
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
    let best = null, span = 0
    polys.forEach((poly) => {
      const c = ringCentroid(poly[0])
      if (!c || (best && c.a <= best.a)) return
      best = c
      let x0 = Infinity, x1 = -Infinity
      poly[0].forEach((p) => { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0] })
      span = x1 - x0
    })
    if (best) sgg.push({
      key: featKey(f), name: f.properties.name, sido: f.properties.sido,
      lat: best.y, lng: best.x, a: best.a, span,
    })
  })
  sgg.sort((p, q) => q.a - p.a)

  // 시도 이름표는 그 안 시군구들의 넓이 가중 평균 자리에 놓는다.
  const bag = {}
  sgg.forEach((o) => { (bag[o.sido] ||= []).push(o) })
  const sido = Object.entries(bag).map(([s, list]) => {
    const A = list.reduce((t, o) => t + o.a, 0) || 1
    return {
      key: `sido:${s}`, name: shortSido(s), sido: s, a: A, span: 999,
      lat: list.reduce((t, o) => t + o.lat * o.a, 0) / A,
      lng: list.reduce((t, o) => t + o.lng * o.a, 0) / A,
    }
  }).sort((p, q) => q.a - p.a)

  LABS = { sgg, sido }
  return LABS
}

// 경도 1도가 이 확대 배율에서 몇 px인지 — 지도를 만지지 않고도 셈할 수 있다.
const pxPerDeg = (z) => (256 * Math.pow(2, z)) / 360

// 21차 — 백지도로 시작한다.
//
// 예전에는 화면을 열자마자 시군구가 색으로 칠해져 있었다. 그런데 그 색은 아직
// 아무것도 고르지 않은 상태에서 프로그램이 임의로 잡아 둔 지표의 색이었다.
// 지표도 표준화 방법도 정하지 않았는데 결과처럼 생긴 그림이 먼저 나오면,
// 보는 사람은 그것을 이미 산출된 값으로 읽는다.
//
// 그래서 지표와 표준화 방법이 확정되기 전(blank)에는 경계와 이름만 있는
// 백지도를 그린다. 지역을 눌러 어디가 어디인지 확인하는 일은 그대로 되고,
// 값에 딸린 것들 — 색 구간, 범례, 민감 지역만 보기, 내보내기 — 은 값이
// 생긴 뒤에 나온다. 표준화 점수가 산출되면 그 자리에 주제도가 채워진다.
export default function NationalMap({
  sector, metric, method = 'minmax', onlyHigh, selected, hovered, onSelect, onHover,
  compact = false, title = null, subtitle = null, onMapReady = null, onToolsReady = null,
  autoFit = true, onlyHighToggle = null, padLeft = 0, tips = true, ver = 0, blank = false,
  hue = null, onHue = null,
}) {
  const geoRef = useRef(null)
  const wrapRef = useRef(null)
  const [map, setMap] = useState(null)
  const [labelsOn, setLabelsOn] = useState(true)
  const [dlOpen, setDlOpen] = useState(false)
  const [dlMsg, setDlMsg] = useState('')

  const geo = useMemo(geoData, [])
  const byKey = useMemo(() => Object.fromEntries(ROWS.map((r) => [rowKey(r), r])), [])

  const vals = useMemo(() => valuesOf(metric), [metric])

  // ── 색 구간 나누기 ─────────────────────────────────────────────────────
  // 같은 값이라도 어디서 끊느냐에 따라 지도가 다르게 보인다.
  // 지표마다 분포 모양이 다르므로 기본값은 분포를 보고 자동으로 고르고,
  // 사용자가 등간격·분위수·자연분류·표준편차로 직접 바꿀 수 있게 둔다.
  const [cmode, setCmode] = useState('auto')
  const auto = useMemo(() => autoMode(vals, metric.scale), [vals, metric.scale])
  const eff = cmode === 'auto' ? auto : cmode
  const breaks = useMemo(() => breaksOf(vals, eff, 7), [vals, eff])
  const ramp = (hue && HUES[hue]) || RAMP[metric.scale] || BLUE
  const color = useMemo(() => {
    const at = classOf(breaks)
    const rev = metric.scale === 'rank'          // 1위가 가장 진하게
    return (v) => {
      const i = at(v)
      if (i < 0) return '#E9ECF1'
      return ramp[rev ? ramp.length - 1 - i : Math.min(ramp.length - 1, i)]
    }
  }, [breaks, metric.scale, ramp])
  const valOf = (k) => { const i = rowIndex(k); return i == null ? null : vals[i] }

  // 서로 다른 값이 몇 가지뿐인 지표 — 참고 플래그의 '해당 / 해당 없음'이 그렇다.
  // 이런 값은 구간을 일곱으로 나눌 것이 없다. 경계 숫자(0.5)를 눈금에 적어 봐야
  // 읽을 것이 없으므로, 눈금 대신 값 이름을 양 끝에 적고 구간 나누기 단추를 뺀다.
  const few = useMemo(() => {
    const u = [...new Set(vals.filter((x) => x != null && Number.isFinite(x)))].sort((a, b) => a - b)
    return u.length >= 2 && u.length <= 7 ? u : null
  }, [vals])

  const styleFor = (f) => {
    const k = featKey(f)
    const row = byKey[k]
    const isSel = k === selected, isHov = k === hovered

    // 백지도 — 옅은 면에 회색 경계. 누른 곳과 커서 아래만 진하게 남긴다.
    if (blank) return {
      fillColor: isSel ? '#D6E7F7' : isHov ? '#E7EDF4' : '#F2F5F8',
      fillOpacity: 1,
      color: isSel ? '#0F172A' : isHov ? '#334155' : '#C3CDD9',
      weight: isSel ? 2.6 : isHov ? 1.8 : 0.7,
      opacity: 1,
    }

    const high = row && row[sector]?.flag === 'high'
    const dim = onlyHigh && !high
    // 경계선은 흰색 하나로 통일한다. 예전에는 민감(high) 지역 경계를 붉게
    // 둘렀는데, 민감 지역이 많으면 지도 전체에 붉은 그물이 덮여 주제도
    // 읽기를 방해했다. 민감 지역은 '민감 지역만' 토글(다른 곳 흐림)로 본다.
    return {
      fillColor: color(valOf(k)),
      fillOpacity: dim ? 0.06 : isSel ? 0.95 : isHov ? 0.88 : 0.82,
      color: isSel ? '#0F172A' : isHov ? '#334155' : '#ffffff',
      weight: isSel ? 2.6 : isHov ? 1.8 : 0.5,
      opacity: dim ? 0.3 : 1,
    }
  }

  const tipHtml = (k, row) => (blank ? `
    <div class="mpop">
      <div class="mpop-h">${row.sido} ${row.name}</div>
      <div class="mtip-row"><span>지표를 고르면 점수가 나옵니다</span></div>
    </div>` : `
    <div class="mpop">
      <div class="mpop-h">${row.sido} ${row.name}</div>
      <div class="mtip-row"><span>${metric.full || metric.label}</span><b>${metric.fmt(valOf(k))}</b></div>
      <div class="mtip-row"><span>순위 이동</span><b>${row[sector]?.ssiCamp}계단${row[sector]?.flag === 'high' ? ' · 민감' : ''}</b></div>
    </div>`)

  const onEach = (f, layer) => {
    const k = featKey(f); const row = byKey[k]
    // 나란히 보기에서는 지도마다 말풍선이 뜨면 두 번 겹친다.
    // 그때는 부모가 커서를 따라다니는 팝업 하나로 두 지도의 값을 함께 보여 준다.
    if (row && tips) layer.bindTooltip(tipHtml(k, row), { sticky: true, direction: 'top', opacity: 1, className: 'm-tip' })
    layer.on({
      click: () => onSelect(k),
      mouseover: () => onHover?.(k),
      mouseout: () => onHover?.(null),
    })
  }

  useEffect(() => {
    if (!geoRef.current) return
    geoRef.current.setStyle(styleFor)
    let selLayer = null, hovLayer = null
    geoRef.current.eachLayer((l) => {
      const k = featKey(l.feature); const row = byKey[k]
      if (row && l.getTooltip()) l.setTooltipContent(tipHtml(k, row))
      if (k === selected) selLayer = l
      if (k === hovered) hovLayer = l
    })
    // 선택·커서 아래 폴리곤을 맨 위로 — 그래야 굵은 테두리가 이웃 폴리곤에
    // 덮이지 않고 경계 전체가 온전히 보인다(예전에는 절반만 굵게 보였다).
    if (hovLayer?.bringToFront) hovLayer.bringToFront()
    if (selLayer?.bringToFront) selLayer.bringToFront()
  })

  // ── 지도 이동 조작 ──────────────────────────────────────────────────────
  const boundsOf = (pred) => {
    if (!geoRef.current) return null
    let b = null
    geoRef.current.eachLayer((l) => {
      if (!pred(featKey(l.feature))) return
      b = b ? b.extend(l.getBounds()) : l.getBounds()
    })
    return b && b.isValid() ? b : null
  }
  // 지도가 화면 전체에 깔리고 조작·통계 패널이 그 위에 떠 있으므로,
  // '보이는 영역'은 패널 폭(padLeft)만큼 오른쪽으로 밀린 사각형이다.
  // 지도를 맞출 때 그 폭을 여백으로 넣어야 국토가 패널 뒤로 숨지 않는다.
  const pad = (g) => ({ paddingTopLeft: [padLeft + g, g], paddingBottomRight: [g, g] })

  // 사람이 실제로 들여다보는 덩어리 — 본토와 제주.
  // 전체 경계에는 백령도·독도까지 들어가 있어 그대로 가운데를 잡으면
  // 정작 보고 싶은 곳이 한쪽으로 밀린다. 그래서 '맞추는 건 전체, 가운데는 본토'로 나눈다.
  const CORE = L.latLngBounds([33.10, 126.10], [38.62, 129.62])

  // 여백을 뺀 '보이는 상자' 한가운데에 경계를 놓는다.
  // core=true 면 가로 위치만 본토 기준으로 다시 잡되,
  // 그러다 도서가 화면 밖으로 나가지 않도록 안전 범위 안에서만 움직인다.
  const fitTo = (b, g, { core = false, keepIn = null, duration = 0.6 } = {}) => {
    if (!map || !b) return
    const tl = L.point(padLeft + g, g), br = L.point(g, g)
    const size = map.getSize()
    const z = map.getBoundsZoom(b, false, tl.add(br))
    const off = br.subtract(tl).divideBy(2)
    const sw = map.project(b.getSouthWest(), z), ne = map.project(b.getNorthEast(), z)
    const c = sw.add(ne).divideBy(2).add(off)
    if (core) {
      c.x = map.project(CORE.getCenter(), z).x + off.x        // 가로는 본토 기준으로 가운데
      const k = keepIn || b
      const ksw = map.project(k.getSouthWest(), z), kne = map.project(k.getNorthEast(), z)
      const lo = kne.x - size.x / 2 + br.x     // 이보다 왼쪽이면 동쪽 끝(독도)이 잘린다
      const hi = ksw.x + size.x / 2 - tl.x     // 이보다 오른쪽이면 서쪽 끝(백령도)이 잘린다
      if (lo <= hi) c.x = Math.min(hi, Math.max(lo, c.x))     // 다 담을 수 있을 때만 도서를 지킨다
    }
    map.flyTo(map.unproject(c, z), z, { duration })
  }

  // 주변국 이름표 — 회색 작은 글씨로 고정. 시군구 이름표 켜고 끄기와 무관하다.
  useEffect(() => {
    if (!map) return
    const lay = L.layerGroup(NB_LABELS.map(([t, lat, lng]) => L.marker([lat, lng], {
      interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'nb-lab', html: `<span>${t}</span>`, iconSize: [0, 0] }),
    }))).addTo(map)
    return () => { lay.remove() }
  }, [map])

  // 전국 보기 — 도서까지 담느라 지도가 눈에 띄게 작아지면(9% 이상) 본토 기준으로 맞춘다.
  // 백령도·독도 때문에 경도 폭이 본토의 두 배가 되어, 좁은 화면에서 국토가 손톱만 해지기 때문이다.
  const fitAll = (duration = 0.6) => {
    const all = boundsOf(() => true)
    if (!map || !all) return
    const g = 8, p = L.point(padLeft + g, g).add(L.point(g, g))
    const zAll = map.getBoundsZoom(all, false, p), zCore = map.getBoundsZoom(CORE, false, p)
    fitTo(zCore - zAll > 0.12 ? CORE : all, g, { core: true, keepIn: all, duration })
  }
  const fitSel = () => fitTo(boundsOf((k) => k === selected), 70, { duration: 0.7 })

  // 선택을 풀고 전국 화면으로 되돌린다. 지금까지는 지도 빈 곳을 눌러야만 풀렸는데,
  // 빈 곳은 누를 이유가 없는 자리라 되돌아가는 길이 사실상 없는 것과 같았다.
  const backToAll = () => { onSelect(null); fitAll() }

  // 조작 함수 묶음 — 나란히 보기(듀얼)에서 부모가 공용 도구막대로 쓴다.
  const apiRef = useRef({})
  apiRef.current = {
    fitAll, fitSel,
    zoomIn: () => map && map.zoomIn(),
    zoomOut: () => map && map.zoomOut(),
  }

  const firstRef = useRef(true)
  useEffect(() => {
    if (!map) return
    onMapReady?.(map)
    onToolsReady?.(apiRef)
    if (!compact && typeof window !== 'undefined') window.__map = map   // 자동 검증용 손잡이
    if (!geoRef.current || !firstRef.current) return
    firstRef.current = false
    try { fitAll(0) } catch (e) { /* noop */ }
  }, [map])

  // 통계창을 접거나 펴면 '가려지지 않은 영역'의 한가운데가 옆으로 움직인다.
  // 확대 배율은 그대로 두고 그 이동분의 절반만큼 지도를 밀어, 보이는 자리에 국토가 계속 가운데 오게 한다.
  const padRef = useRef(padLeft)
  useEffect(() => {
    const d = padRef.current - padLeft
    padRef.current = padLeft
    if (!map || !d) return
    const t = setTimeout(() => { try { map.panBy([d / 2, 0], { animate: true, duration: 0.4 }) } catch (e) { /* noop */ } }, 20)
    return () => clearTimeout(t)
  }, [padLeft, map])

  // ── 시군구 이름표 ──────────────────────────────────────────────────────
  // 확대 배율이 정해지면 화면 위 거리도 정해지므로, 겹침 계산은 확대할 때만 다시 한다.
  // 지도를 끌어 옮기는 동안에는 Leaflet이 이름표 판을 통째로 밀어 주기만 하면 된다.
  useEffect(() => {
    if (!map) return
    const pane = map.getPane('sgLabel') || map.createPane('sgLabel')
    pane.style.zIndex = 640
    pane.style.pointerEvents = 'none'
    const group = L.layerGroup([], { pane: 'sgLabel' }).addTo(map)

    const draw = () => {
      group.clearLayers()
      if (!labelsOn) return
      const z = map.getZoom()
      const LB = labelData()
      // 나란히 보기의 작은 지도는 폭이 절반이라 같은 배율에서도 글씨가 빽빽해진다.
      // 그래서 시군구 이름으로 넘어가는 문턱과 최소 폭을 조금 더 높게 잡는다.
      const wide = z < (compact ? 8.2 : 7.4)
      const per = pxPerDeg(z)
      let list = wide ? LB.sido : LB.sgg
      if (!wide) {
        // 이름표가 얹힐 만큼 넓게 그려진 곳만. 선택한 곳은 크기와 무관하게 항상 붙인다.
        list = list.filter((o) => {
          const row = byKey[o.key]
          if (!row) return false
          if (o.key === selected) return true
          if (!blank && onlyHigh && row[sector]?.flag !== 'high') return false
          return o.span * per >= (compact ? 46 : 30)
        })
        // 선택한 지역이 맨 앞에 와야 겹침 다툼에서 이긴다
        list = [...list].sort((p, q) => (q.key === selected) - (p.key === selected))
      }

      // 자리가 겹치면 바로 버리지 않고 한두 칸 밀어 본다.
      // 서울처럼 경기 한가운데 들어앉은 곳은 밀어 주지 않으면 매번 진다.
      const NUDGE = wide
        ? [[0, 0], [0, -1.2], [0, 1.2], [-0.9, 0], [0.9, 0], [-0.9, -1.2], [0.9, 1.2], [0, -2.4], [0, 2.4]]
        : [[0, 0], [0, -1.1], [0, 1.1]]

      const put = []
      list.forEach((o) => {
        const p = map.project([o.lat, o.lng], z)
        const w = o.name.length * (wide ? 11 : 9.4) + 8
        const h = wide ? 17 : 14
        let box = null
        for (let i = 0; i < NUDGE.length; i++) {
          const cx = p.x + NUDGE[i][0] * w, cy = p.y + NUDGE[i][1] * h
          const b = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]
          if (!put.some((q) => !(b[2] < q[0] || b[0] > q[2] || b[3] < q[1] || b[1] > q[3]))) { box = b; break }
        }
        if (!box) return
        put.push(box)
        const ox = (box[0] + box[2]) / 2 - p.x
        const oy = (box[1] + box[3]) / 2 - p.y
        const cls = `sgl${wide ? ' sgl-sido' : ''}${o.key === selected ? ' sgl-on' : ''}`
        L.marker([o.lat, o.lng], {
          pane: 'sgLabel', interactive: false, keyboard: false,
          icon: L.divIcon({ className: cls, html: `<span>${o.name}</span>`, iconSize: [0, 0], iconAnchor: [-ox, -oy] }),
        }).addTo(group)
      })
    }

    draw()
    map.on('zoomend', draw)
    return () => { map.off('zoomend', draw); group.remove() }
  }, [map, labelsOn, onlyHigh, selected, sector, byKey, compact, ver, blank])

  // 통계창 접기/펼치기·창 크기 변화로 지도 폭이 바뀌면 Leaflet에 알린다
  useEffect(() => {
    if (!map || !wrapRef.current || typeof ResizeObserver === 'undefined') return
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => { try { map.invalidateSize({ animate: false }); clampZoom() } catch (e) { /* noop */ } })
    })
    // 64차 — 지도를 그려 둔 범위까지만 축소·이동된다. 최소 배율은 그 범위가 화면을
    // 꽉 채우는 배율이라, 아무리 줄여도 바깥 빈 공간(잘린 해안선)이 보이지 않는다.
    // 지도 칸 크기가 바뀔 때마다 다시 잰다.
    const clampZoom = () => {
      const z = map.getBoundsZoom(DRAWN, true)
      map.setMinZoom(z)
      if (map.getZoom() < z) map.setZoom(z, { animate: false })
      map.panInsideBounds(DRAWN, { animate: false })
    }
    map.setMaxBounds(DRAWN)
    clampZoom()
    ro.observe(wrapRef.current)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [map])

  const lowLab = few ? metric.fmt(few[0])
    : metric.scale === 'rank' ? `하위(${ROWS.length}위)`
      : metric.scale === 'div' ? '◀ 순위 상승' : '낮음'
  const hiLab = few ? metric.fmt(few[few.length - 1])
    : metric.scale === 'rank' ? '상위(1위)'
      : metric.scale === 'div' ? '순위 하락 ▶' : (metric.scale === 'heat' ? '높음(민감)' : '높음')

  // 범례 눈금 — 구간 경계값. 순위 지표는 색이 뒤집혀 있으므로 경계도 함께 뒤집는다.
  const showBreaks = metric.scale === 'rank' ? [...breaks].reverse() : breaks
  const bSpan = breaks.length ? Math.abs(breaks[breaks.length - 1] - breaks[0]) : 1
  const fmtB = (v) => (bSpan >= 20 ? String(Math.round(v)) : v.toFixed(1))
  const tickTitle = few
    ? `값 ${few.length}가지 · ${few.map((x) => metric.fmt(x)).join(' / ')}`
    : `${modeOf(eff).label} · 구간 경계 ${showBreaks.map(fmtB).join(' / ')}`

  // 색 칸마다 그 구간의 범위와 시군구 수 — 색 단계와 수치 기준이 정확히 짝이 되게.
  // cellInfo[i] 는 화면에 그려지는 i번째 색 칸(왼쪽부터)의 설명이다.
  const cellInfo = useMemo(() => {
    const ok = vals.filter((x) => x != null && Number.isFinite(x))
    if (few || !ok.length || !breaks.length) return null
    const vmin = Math.min(...ok), vmax = Math.max(...ok)
    const at = classOf(breaks)
    const counts = new Array(ramp.length).fill(0)
    ok.forEach((v) => { const i = at(v); if (i >= 0) counts[Math.min(ramp.length - 1, i)] += 1 })
    const bounds = [vmin, ...breaks, vmax]
    const rev = metric.scale === 'rank'
    return ramp.map((_, i) => {
      const ci = rev ? ramp.length - 1 - i : i     // 화면 칸 → 값 구간 번호
      const lo = bounds[ci], hi = bounds[ci + 1]
      const [a, b] = rev ? [hi, lo] : [lo, hi]
      return `${fmtB(a)} ~ ${fmtB(b)} · ${counts[ci]}곳`
    })
  }, [vals, breaks, few, ramp, metric.scale])

  // 부문지수 CSV — 시도 · 시군구 · 부문지수(지금 방법) · 지표별 원값.
  // 지도에 칠한 값이 무엇이든, 이 표는 항상 부문지수와 원값을 내준다.
  const dlSectorCsv = () => {
    const inds = indsOf(sector)
    const ml = methodOf(method).label
    const cols = ['시도', '시군구', `부문지수(${ml})`,
      ...inds.map((e) => `${e.label}(${e.year}${e.unit ? `·${e.unit}` : ''})`)]
    const esc = (c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)
    const lines = [cols.map(esc).join(',')]
    ROWS.forEach((r) => {
      const d = r[sector]
      const ci = d?.ci?.[method]
      lines.push([r.sido, r.name,
        ci == null ? '' : Math.round(ci * 1000) / 1000,
        ...inds.map((e) => (d?.raw?.[e.label] ?? '')),
      ].map(esc).join(','))
    })
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `부문지수_${SECTORS[sector].name.replace(/\s/g, '')}_${ml}_${ROWS.length}행.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    setDlMsg(`부문지수 CSV 내려받음 — ${ROWS.length}행 · ${cols.length}열`)
    setTimeout(() => setDlMsg(''), 2200)
  }

  // ── 내보내기 ────────────────────────────────────────────────────────────
  // 지금 화면에 칠해진 그대로를 파일로 뽑는다. 전국 229개 시군구가 통째로 나간다.
  const DL = { shp: 'Shapefile(.zip)', geojson: 'GeoJSON', csv: 'CSV 표' }
  const doExport = (kind) => {
    setDlOpen(false)
    let n = 0
    try {
      const o = { geo, byKey, sector, method, metric, valOf }
      n = kind === 'shp' ? exportShapefile(o) : kind === 'geojson' ? exportGeoJSON(o) : exportCSV(o)
    } catch (e) {
      setDlMsg('내보내는 중 문제가 생겼습니다')
      setTimeout(() => setDlMsg(''), 3200)
      return
    }
    setDlMsg(n ? `전국 ${n}개 시군구 · ${DL[kind]} 내려받음` : '내보낼 지역이 없습니다')
    setTimeout(() => setDlMsg(''), 3400)
  }

  const selRow = selected ? byKey[selected] : null
  const hovRow = hovered ? byKey[hovered] : null
  const shown = hovRow || selRow

  return (
    <div ref={wrapRef} className={`map-canvas${compact ? ' map-compact' : ''}`}>
      {title && <div className="map-cap"><b>{title}</b>{subtitle && <em>{subtitle}</em>}</div>}
      {/* zoomSnap=0 — 확대 단계를 정수로 끊지 않는다.
          정수로 끊으면 화면이 남아도 한 단계 낮은 배율로 내려가 지도가 작아 보인다. */}
      {/* 62차 — 외부 배경지도(CARTO 타일)를 쓰지 않는다. html 파일을 더블클릭해 열면
          (file://) 요청에 출처 정보가 붙지 않아 타일 서버가 막고 'API 키 필요' 그림을
          돌려보냈고, 기관 내부망에서는 서버 자체가 막히기도 했다. 시군구 경계는 파일
          안에 들어 있으므로 바다는 바탕색, 땅은 시군구 폴리곤만으로 그린다 —
          인터넷이 없어도, 어디서 열어도 같은 지도가 나온다. */}
      <MapContainer ref={setMap} center={[36.4, 127.8]} zoom={compact ? 6 : 7} zoomControl={false}
        zoomSnap={0} zoomDelta={0.5} wheelPxPerZoomLevel={90} attributionControl={false}
        maxBounds={[[31.3, 119.5], [41.2, 135.5]]} maxBoundsViscosity={1}
        preferCanvas={true} scrollWheelZoom={true} style={{ height: '100%', width: '100%' }}>
        <GeoJSON data={neighborGeo} style={() => NB_STYLE} interactive={false} />
        <GeoJSON ref={geoRef} data={geo} style={styleFor} onEachFeature={onEach} />
      </MapContainer>

      {/* 지도 조작 도구 — 오른쪽 위 세로 스택(＋ − ↺ ⤢) */}
      {!compact && (
        <div className="mapz">
          <button onClick={() => map && map.zoomIn()} title="확대" aria-label="확대"><Plus size={13} /></button>
          <button onClick={() => map && map.zoomOut()} title="축소" aria-label="축소"><Minus size={13} /></button>
          <span className="mapz-sep" />
          <button onClick={fitAll} title="전국이 한 화면에 들어오도록" aria-label="화면 맞추기"><Reset size={13} /></button>
          <button onClick={fitSel} disabled={!selected} title="선택한 시군구를 확대"
            aria-label="선택 지역 확대"><Expand size={13} /></button>
          <span className="mapz-sep" />
          <button className={labelsOn ? 'on' : ''} onClick={() => setLabelsOn(!labelsOn)}
            aria-pressed={labelsOn} title={labelsOn ? '시군구 이름표 끄기' : '시군구 이름표 켜기'}
            aria-label="시군구 이름표">가</button>
          {!blank && (
            <button className={dlOpen ? 'on' : ''} onClick={() => setDlOpen(!dlOpen)}
              aria-expanded={dlOpen} title="지금 지도를 파일로 내보내기" aria-label="내보내기">⤓</button>
          )}
        </div>
      )}

      {/* 전국으로 되돌아가는 단추. 시군구를 고른 동안에만 나오고, 누르면 선택을
          풀고 배율까지 전국 보기로 되돌린다. */}
      {!compact && selected && (
        <button className="mapback" onClick={backToAll}
          title="선택을 풀고 전국 화면으로 돌아갑니다" aria-label="전국으로 돌아가기">
          <i>←</i>전국으로 돌아가기
        </button>
      )}

      {/* 내보내기 차림표 — 지금 화면에 칠해진 값과 범위를 그대로 담는다 */}
      {!compact && dlOpen && (
        <>
          <div className="mapdl-veil" onClick={() => setDlOpen(false)} />
          <div className="mapdl">
            <div className="mapdl-h">
              내보내기
              <em>{SECTORS[sector]?.name} · {metric.full || metric.label} · 전국</em>
            </div>
            <button onClick={() => doExport('shp')}>
              <b>Shapefile (.zip)</b><span>QGIS·ArcGIS에서 바로 열립니다 · EPSG:4326</span>
            </button>
            <button onClick={() => doExport('geojson')}>
              <b>GeoJSON (.geojson)</b><span>웹 지도·파이썬에서 쓰기 좋습니다</span>
            </button>
            <button onClick={() => doExport('csv')}>
              <b>표 (.csv)</b><span>도형 없이 값만 · 엑셀에서 바로 열립니다</span>
            </button>
            <p className="mapdl-n">
              시도·시군구·지도 색 기준 값·부문점수·순위·표준점수(T)·백분위·순위 이동이 함께 들어갑니다.
              항목 이름 풀이는 압축 파일 안 <b>읽어보기.txt</b>에 있습니다.
            </p>
          </div>
        </>
      )}

      {dlMsg && <div className="map-toast">{dlMsg}</div>}

      {/* 보기 옵션 — 오른쪽 아래. 지도를 보는 중에도 손이 닿는 자리.
          맨 앞의 큰 단추는 부문지수 내려받기 — 최종 지도에서 가장 자주
          찾는 산출물이라, 시도 · 시군구 · 부문지수(지금 방법) · 지표별
          원값을 한 표로 바로 내준다. */}
      {!compact && !blank && onlyHighToggle && (
        <div className="mapsw">
          <button className="map-bigdl" onClick={dlSectorCsv}
            title={`시도 · 시군구 · 부문지수(${methodOf(method).label}) · 지표별 원값 — ${ROWS.length}행 CSV`}>
            <Download size={15} /> 부문지수 CSV 내려받기
          </button>
          <button className={`msw-t${onlyHigh ? ' on' : ''}`} onClick={onlyHighToggle}
            aria-pressed={onlyHigh} title="표준화 방법을 바꿨을 때 순위가 10계단 이상 움직인 곳만 남기고 나머지는 흐리게">
            <i /><span>{onlyHigh ? 'ON' : 'OFF'} · 민감 지역만</span>
          </button>
          <button className="msw-r" onClick={fitAll} title="지도 위치를 처음으로">초기화</button>
        </div>
      )}

      {/* 커서 아래 / 선택 지역 실시간 표시 — 지도와 통계창을 잇는 고리 */}
      {!compact && shown && (
        <div className={`map-live${hovRow ? ' hov' : ''}`}>
          <b>{shown.sido} {shown.name}</b>
          {!blank && <span>{metric.full || metric.label}<i>{metric.fmt(valOf(rowKey(shown)))}</i></span>}
          {!blank && <span>순위 이동<i>{shown[sector]?.ssiCamp}계단</i></span>}
          {!blank && shown[sector]?.flag === 'high' && <em className="ml-high">민감</em>}
        </div>
      )}


      {blank ? (
        <div className={`maplegend mapblank${compact ? ' lg-mini' : ''}`}>
          <h4>백지도</h4>
          <p className="ml-note">
            지표를 고르고 표준화 방법을 정하면 표준화 점수가 산출되고, 그 값으로 이 지도가
            칠해집니다. 그 전까지는 경계와 이름만 보여 줍니다.
          </p>
        </div>
      ) : (
      <div className={`maplegend${compact ? ' lg-mini' : ''}`}>
        <h4>{metric.full || metric.label}</h4>
        <div className="ml-scale" title={tickTitle}>
          {ramp.map((c, i) => <i key={i} style={{ background: c }} title={cellInfo ? cellInfo[i] : undefined} />)}
        </div>
        {/* 구간 경계는 전부 적는다 — 색이 일곱 단계면 경계 숫자도 여섯 개.
            자리가 좁으므로 위·아래 두 줄로 엇갈려 놓는다. 칸에 올리면 범위·시군구 수. */}
        {!few && (
          <div className="ml-tk tk2">
            {showBreaks.map((b, i) => (
              <span key={i} className={i % 2 ? 'lo' : ''}
                style={{ left: `${((i + 1) / 7) * 100}%` }}>{fmtB(b)}</span>
            ))}
          </div>
        )}
        <div className="ml-ends"><span>{lowLab}</span><span>{hiLab}</span></div>

        {/* 지도 색 고르기 — onHue를 받은 지도(2종 비교의 좌·우)만.
            조작이 범례 옆에 있어야 색을 바꾼 결과가 바로 그 자리에서 읽힌다. */}
        {onHue && (
          <div className="ml-hues">
            <u>지도 색</u>
            <HueDots small hue={hue || 'auto'} onHue={onHue} />
          </div>
        )}

        {/* 구간을 어떻게 끊었는지 — 지도가 달라 보이는 진짜 이유의 절반이 여기 있다 */}
        {!compact && few && (
          <p className="ml-note">
            값이 {few.length}가지뿐이라 구간을 나누지 않고 값 그대로 칠했습니다.
          </p>
        )}

        {!compact && !few && (
          <div className="ml-cls">
            <div className="mlc-seg">
              <button className={cmode === 'auto' ? 'on' : ''} onClick={() => setCmode('auto')}
                title={`분포에 맞춰 자동 선택 · 지금은 ${modeOf(auto).label}`}>자동</button>
              {CLASS_MODES.map((m) => (
                <button key={m.key} className={cmode === m.key ? 'on' : ''}
                  onClick={() => setCmode(m.key)} title={m.desc}>{m.label}</button>
              ))}
            </div>
            <p className="ml-note">
              <b>{modeOf(eff).label}</b>
              {cmode === 'auto' ? ` · ${autoReason(vals, metric.scale)}` : ` · ${modeOf(eff).desc}`}
            </p>
          </div>
        )}
      </div>
      )}
    </div>
  )
}
