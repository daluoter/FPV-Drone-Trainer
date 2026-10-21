import * as THREE from 'three'

import type { DroneConfig, DroneState } from '../drone'
import { DEFAULT_DRONE_CONFIG, DRONE_GEOMETRY } from '../drone'
import { createTrainingFieldAnchors } from '../training/field'
import { STRAIGHT_LINE_BRAKE_ZONE_START_M, STRAIGHT_LINE_CORRIDOR_HALF_WIDTH_M, STRAIGHT_LINE_ROUTE_LENGTH_M, STRAIGHT_LINE_STOP_RADIUS_M, STRAIGHT_LINE_TRANSIT_DISTANCE_M } from '../training/straightLine'
import type { Vector3 } from '../math/vector'
import type { ReplayGhostState } from '../replay'

export type FlightSceneReferenceKind = 'pad' | 'zone' | 'marker' | 'gate' | 'poi'

/** Stable environment identity exposed to future training evaluators. */
export interface FlightSceneReference {
  readonly id: string
  readonly kind: FlightSceneReferenceKind
  readonly object: THREE.Object3D
  readonly positionM: Vector3
  readonly sizeM?: Vector3
}

export interface FlightScene {
  readonly scene: THREE.Scene
  readonly drone: THREE.Group
  readonly ghost: THREE.Group
  readonly ground: THREE.Mesh
  readonly grid: THREE.GridHelper
  readonly takeoffPad: THREE.Object3D
  /** Legacy visual collection; use sceneReferences for stable lesson IDs. */
  readonly references: readonly THREE.Object3D[]
  readonly sceneReferences: readonly FlightSceneReference[]
  getReference(id: string): FlightSceneReference | null
  applyState(state: DroneState): void
  /** Apply an independent presentation ghost; this never mutates DroneState. */
  applyGhost(state: Pick<ReplayGhostState, 'positionM' | 'orientation'>): void
  setReplayVisible(visible: boolean): void
  /** Lesson-specific visual guidance; evaluator anchors remain unchanged. */
  setLessonTarget(lessonId: string | null): void
  /** Presentation-only bounded path trace; evaluators remain renderer-independent. */
  setTrainingPath(path: readonly Vector3[]): void
  setReplayPath(path: readonly Vector3[]): void
  dispose(): void
}

function material(color: number, roughness = 0.72, metalness = 0.05): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness })
}

function createQuadVisual(): THREE.Group {
  const quad = new THREE.Group()
  quad.name = 'quad'

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(DRONE_GEOMETRY.body.sizeM.x, DRONE_GEOMETRY.body.sizeM.y, DRONE_GEOMETRY.body.sizeM.z),
    material(0x26343a, 0.5, 0.4),
  )
  body.name = 'quad-body'
  quad.add(body)

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(DRONE_GEOMETRY.nose.sizeM.x / 2, DRONE_GEOMETRY.nose.sizeM.z, 4),
    material(0xb8f36b, 0.55, 0.2),
  )
  nose.name = 'quad-nose'
  nose.rotation.x = -Math.PI / 2
  nose.position.set(DRONE_GEOMETRY.nose.centerM.x, DRONE_GEOMETRY.nose.centerM.y, DRONE_GEOMETRY.nose.centerM.z)
  quad.add(nose)

  const armMaterial = material(0x71909b, 0.58, 0.28)
  const motorMaterial = material(0x101820, 0.4, 0.65)
  const propMaterial = new THREE.MeshStandardMaterial({
    color: 0x91a4b0,
    transparent: true,
    opacity: 0.45,
    roughness: 0.7,
  })
  for (const [index, motorPosition] of DRONE_GEOMETRY.motors.positionsM.entries()) {
    const armGeometry = DRONE_GEOMETRY.arms
    const armPlacement = armGeometry.placements[index]
    const arm = new THREE.Mesh(new THREE.BoxGeometry(armGeometry.sizeM.x, armGeometry.sizeM.y, armGeometry.sizeM.z), armMaterial)
    arm.name = `quad-arm-${index}`
    arm.position.set(armPlacement.centerM.x, armPlacement.centerM.y, armPlacement.centerM.z)
    arm.rotation.y = armPlacement.rotationYRad
    quad.add(arm)

    const motor = new THREE.Mesh(
      new THREE.CylinderGeometry(DRONE_GEOMETRY.motors.radiusM, DRONE_GEOMETRY.motors.radiusM, DRONE_GEOMETRY.motors.heightM, 12),
      motorMaterial,
    )
    motor.name = `quad-motor-${index}`
    motor.position.set(motorPosition.x, motorPosition.y, motorPosition.z)
    quad.add(motor)

    const propSize = DRONE_GEOMETRY.propellers.sizeM
    const prop = new THREE.Mesh(new THREE.BoxGeometry(propSize.x, propSize.y, propSize.z), propMaterial)
    prop.name = `quad-prop-${index}`
    prop.position.set(motorPosition.x, motorPosition.y + DRONE_GEOMETRY.propellers.centerYFromMotorM, motorPosition.z)
    prop.rotation.y = index % 2 === 0 ? Math.PI / 4 : -Math.PI / 4
    quad.add(prop)
  }

  return quad
}

function createReferenceObjects(spawnPositionM: Vector3, groundHeightM: number): {
  readonly objects: readonly THREE.Object3D[]
  readonly contract: readonly FlightSceneReference[]
} {
  const references: THREE.Object3D[] = []
  const contract: FlightSceneReference[] = []

  // The hover reference is deliberately above the pad. Its position is an
  // immutable evaluator anchor; the visual cylinder is presentation only.
  const hoverZonePosition = { x: spawnPositionM.x, y: groundHeightM + 3, z: spawnPositionM.z }
  const hoverZone = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.2, 0.04, 32),
    new THREE.MeshStandardMaterial({
      color: 0xb8f36b,
      transparent: true,
      opacity: 0.32,
      roughness: 0.7,
    }),
  )
  hoverZone.name = 'reference-hover-zone'
  hoverZone.position.set(hoverZonePosition.x, hoverZonePosition.y, hoverZonePosition.z)
  references.push(hoverZone)
  contract.push({
    id: 'hover-zone',
    kind: 'zone',
    object: hoverZone,
    positionM: hoverZonePosition,
    sizeM: { x: 2.4, y: 0.04, z: 2.4 },
  })

  const colors = [0xffc978, 0xb8f36b, 0x8abac4, 0xd28bff]
  const markers = [
    { id: 'turn-entry', name: 'reference-turn-entry', position: { x: -4, y: 0.45, z: -4 } },
    { id: 'turn-apex', name: 'reference-turn-apex', position: { x: 4, y: 0.45, z: -4 } },
    { id: 'turn-exit', name: 'reference-turn-exit', position: { x: -4, y: 0.45, z: 4 } },
    { id: 'orbit-poi', name: 'reference-orbit-poi', position: { x: 4, y: 2.5, z: 4 } },
  ] as const
  for (const [index, markerDefinition] of markers.entries()) {
    const markerMaterial = material(colors[index], 0.65, 0.1)
    const marker = new THREE.Group()
    marker.name = markerDefinition.name
    marker.position.set(
      markerDefinition.position.x,
      groundHeightM + markerDefinition.position.y,
      markerDefinition.position.z,
    )
    if (markerDefinition.id === 'orbit-poi') {
      const tower = new THREE.Mesh(new THREE.ConeGeometry(0.18, 4, 6), markerMaterial)
      tower.position.y = 0
      marker.add(tower)
      const orbitCircle = new THREE.Mesh(
        new THREE.RingGeometry(9.7, 10.1, 96),
        new THREE.MeshBasicMaterial({ color: colors[index], transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
      )
      orbitCircle.name = 'reference-orbit-circle'
      orbitCircle.rotation.x = -Math.PI / 2
      orbitCircle.position.y = -markerDefinition.position.y + 0.02
      marker.add(orbitCircle)
    } else {
      const leftPost = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.9, 10), markerMaterial)
      const rightPost = leftPost.clone()
      leftPost.position.set(-1.3, -0.0, 0)
      rightPost.position.set(1.3, -0.0, 0)
      const crossbar = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.08, 0.08), markerMaterial)
      crossbar.position.y = 0.4
      marker.add(leftPost, rightPost, crossbar)
    }
    references.push(marker)
    contract.push({
      id: markerDefinition.id,
      kind: markerDefinition.id === 'orbit-poi' ? 'poi' : 'marker',
      object: marker,
      positionM: { ...markerDefinition.position, y: groundHeightM + markerDefinition.position.y },
      sizeM: markerDefinition.id === 'orbit-poi'
        ? { x: 0.36, y: 4, z: 0.36 }
        : { x: 0.36, y: 0.9, z: 0.36 },
    })
  }

  const gate = new THREE.Group()
  gate.name = 'reference-split-s'
  gate.position.y = groundHeightM
  const gateMaterial = material(0x334d58, 0.72, 0.05)
  for (const [x, z] of [[-2.5, -5], [2.5, -5]] as const) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.8, 0.12), gateMaterial)
    post.position.set(x, 0.9, z)
    gate.add(post)
  }
  const crossbar = new THREE.Mesh(new THREE.BoxGeometry(5.12, 0.12, 0.12), gateMaterial)
  crossbar.position.set(0, 1.78, -5)
  gate.add(crossbar)
  references.push(gate)
  contract.push({
    id: 'split-s-reference',
    kind: 'gate',
    object: gate,
    positionM: { x: 0, y: groundHeightM + 0.9, z: -5 },
    sizeM: { x: 5.12, y: 1.8, z: 0.12 },
  })
  return { objects: references, contract }
}

function disposeMaterial(materialValue: THREE.Material): void {
  const record = materialValue as THREE.Material & Record<string, unknown>
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object' && 'isTexture' in value && typeof (value as THREE.Texture).dispose === 'function') {
      ;(value as THREE.Texture).dispose()
    }
  }
  materialValue.dispose()
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (mesh.geometry && typeof mesh.geometry.dispose === 'function') mesh.geometry.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    for (const materialValue of materials) disposeMaterial(materialValue)
  })
}

export function disposeFlightScene(scene: THREE.Scene): void {
  disposeObject(scene)
  scene.clear()
}

/**
 * Build the deliberately small Phase 4 field. All visual objects remain
 * presentation-only; the simulation owns ground contact and the quad state.
 */
export function createFlightScene(config: DroneConfig = DEFAULT_DRONE_CONFIG): FlightScene {
  // Match the authoritative upright spawn clamp, including configured contact
  // geometry. The pad's teaching anchor may not remain below raised ground.
  const field = createTrainingFieldAnchors(config)
  const teachingSpawn = field.pad
  const scene = new THREE.Scene()
  scene.name = 'free-flight-scene'
  scene.background = new THREE.Color(0x080d13)
  scene.fog = new THREE.Fog(0x080d13, 18, 85)

  const ambient = new THREE.HemisphereLight(0xbed7df, 0x111a20, 1.5)
  ambient.name = 'ambient-light'
  scene.add(ambient)
  const key = new THREE.DirectionalLight(0xffffff, 2.1)
  key.name = 'key-light'
  key.position.set(-8, 12, 6)
  scene.add(key)

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    material(0x101b20, 0.95, 0),
  )
  ground.name = 'ground'
  ground.rotation.x = -Math.PI / 2
  ground.position.y = config.ground.heightM
  scene.add(ground)

  const grid = new THREE.GridHelper(120, 60, 0x38535d, 0x1e323b)
  grid.name = 'grid'
  grid.position.y = config.ground.heightM + 0.006
  scene.add(grid)

  const takeoffPad = new THREE.Group()
  takeoffPad.name = 'takeoff-pad'
  const padBase = new THREE.Mesh(
    new THREE.PlaneGeometry(2.4, 2.4),
    material(0x17262e, 0.78, 0.12),
  )
  padBase.rotation.x = -Math.PI / 2
  padBase.position.y = config.ground.heightM + 0.007
  takeoffPad.add(padBase)
  const padLineMaterial = material(0xb8f36b, 0.58, 0.15)
  for (const [x, z, width, depth] of [
    [0, -1.04, 2.0, 0.035],
    [0, 1.04, 2.0, 0.035],
    [-1.04, 0, 0.035, 2.0],
    [1.04, 0, 0.035, 2.0],
  ] as const) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(width, 0.012, depth), padLineMaterial)
    line.position.set(x, config.ground.heightM + 0.012, z)
    takeoffPad.add(line)
  }
  takeoffPad.position.set(config.spawnPositionM.x, 0, config.spawnPositionM.z)
  scene.add(takeoffPad)

  const referenceSet = createReferenceObjects(teachingSpawn, config.ground.heightM)
  for (const reference of referenceSet.objects) scene.add(reference)

  // Takeoff asks for +2 m relative to the normalized spawn anchor. Hover's
  // separate target remains 3 m above configured ground. These guides are visual.
  const takeoffHeightTarget = new THREE.Group()
  takeoffHeightTarget.name = 'takeoff-height-target'
  takeoffHeightTarget.position.set(
    teachingSpawn.x,
    teachingSpawn.y + 2,
    teachingSpawn.z,
  )
  takeoffHeightTarget.visible = false
  const targetMaterial = new THREE.MeshBasicMaterial({
    color: 0xffc978,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  const targetRing = new THREE.Mesh(new THREE.RingGeometry(1.12, 1.2, 64), targetMaterial)
  targetRing.name = 'takeoff-height-ring'
  targetRing.rotation.x = -Math.PI / 2
  const targetBand = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.2, 0.08, 64, 1, true),
    targetMaterial.clone(),
  )
  targetBand.name = 'takeoff-height-band'
  takeoffHeightTarget.add(targetRing, targetBand)
  scene.add(takeoffHeightTarget)

  const padReference: FlightSceneReference = {
    id: 'takeoff-pad',
    kind: 'pad',
    object: takeoffPad,
    positionM: { ...teachingSpawn },
    sizeM: { x: 2.4, y: 0.08, z: 2.4 },
  }
  // Landing is a separate visible destination; the launch paint is not its target.
  const landingTarget = new THREE.Group()
  landingTarget.name = 'landing-target'
  landingTarget.position.set(field.landing.x, field.landing.y, field.landing.z)
  landingTarget.visible = false
  const landingPaint = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.85, 64), new THREE.MeshBasicMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }))
  landingPaint.name = 'landing-zone-paint'
  landingPaint.rotation.x = -Math.PI / 2
  landingPaint.position.y = 0.015
  const landingRim = new THREE.Mesh(new THREE.RingGeometry(0.85, 0.96, 64), new THREE.MeshBasicMaterial({ color: 0x45d7f7, side: THREE.DoubleSide }))
  landingRim.rotation.x = -Math.PI / 2
  landingRim.position.y = 0.018
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 3.6, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }))
  beacon.name = 'landing-beacon'
  beacon.position.y = 1.8
  landingTarget.add(landingPaint, landingRim, beacon)
  for (const [x, z] of [[-1.05, -1.05], [1.05, -1.05], [-1.05, 1.05], [1.05, 1.05]]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 2.5, 8), new THREE.MeshBasicMaterial({ color: 0x45d7f7 }))
    post.position.set(x, 1.25, z)
    landingTarget.add(post)
  }
  scene.add(landingTarget)

  const straightTargets = new THREE.Group()
  straightTargets.name = 'straight-line-targets'
  straightTargets.visible = false
  const routeAltitude = field.routeAltitudeM
  const routeReferences: FlightSceneReference[] = []
  for (const [id, distance, color] of [
    ['straight-start', 0, 0x8abac4],
    ['straight-transit', STRAIGHT_LINE_TRANSIT_DISTANCE_M, 0x45d7f7],
    ['straight-brake', STRAIGHT_LINE_BRAKE_ZONE_START_M, 0xffc978],
    ['straight-stop', STRAIGHT_LINE_ROUTE_LENGTH_M, 0xb8f36b],
  ] as const) {
    const marker = new THREE.Group()
    marker.name = id
    marker.position.set(teachingSpawn.x, routeAltitude, teachingSpawn.z - distance)
    const stopZone = id === 'straight-stop'
    const horizontal = stopZone || id === 'straight-start'
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 64), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }))
    ring.name = `${id}-ring`
    if (horizontal) {
      ring.rotation.x = -Math.PI / 2
      ring.scale.setScalar(stopZone ? STRAIGHT_LINE_STOP_RADIUS_M : 0.7)
    } else ring.scale.set(STRAIGHT_LINE_CORRIDOR_HALF_WIDTH_M, 0.7, 1)
    marker.add(ring)
    if (stopZone) {
      const volume = new THREE.Mesh(new THREE.CylinderGeometry(STRAIGHT_LINE_STOP_RADIUS_M, STRAIGHT_LINE_STOP_RADIUS_M, 0.9, 48, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.15, depthWrite: false, side: THREE.DoubleSide }))
      volume.name = 'straight-stop-volume'
      marker.add(volume)
    }
    straightTargets.add(marker)
    routeReferences.push({ id, kind: 'zone', object: marker, positionM: { x: marker.position.x, y: marker.position.y, z: marker.position.z }, sizeM: stopZone ? { x: STRAIGHT_LINE_STOP_RADIUS_M * 2, y: 0.9, z: STRAIGHT_LINE_STOP_RADIUS_M * 2 } : { x: STRAIGHT_LINE_CORRIDOR_HALF_WIDTH_M * 2, y: 1.4, z: 0.08 } })
  }
  scene.add(straightTargets)
  const landingSurface: FlightSceneReference = { id: 'landing-surface', kind: 'zone', object: landingTarget, positionM: { ...field.landing }, sizeM: { x: 1.7, y: 0, z: 1.7 } }
  const launchReference: FlightSceneReference = { id: 'training-launch', kind: 'pad', object: takeoffPad, positionM: { ...field.launch } }
  const sceneReferences = [padReference, ...referenceSet.contract, landingSurface, launchReference, ...routeReferences]
  const referenceById = new Map(sceneReferences.map((reference) => [reference.id, reference]))

  const drone = createQuadVisual()
  scene.add(drone)

  const ghost = createQuadVisual()
  ghost.name = 'replay-ghost'
  ghost.visible = false
  ghost.traverse((object) => {
    const mesh = object as THREE.Mesh
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    for (const materialValue of materials) {
      const ghostMaterial = materialValue.clone()
      ghostMaterial.transparent = true
      ghostMaterial.opacity = Math.min(ghostMaterial.opacity, 0.52)
      if ('color' in ghostMaterial && ghostMaterial.color instanceof THREE.Color) ghostMaterial.color.set(0xffc978)
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((candidate) => candidate === materialValue ? ghostMaterial : candidate)
      } else {
        mesh.material = ghostMaterial
      }
    }
  })
  scene.add(ghost)

  const trainingPath = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xb8f36b, transparent: true, opacity: 0.8 }),
  )
  trainingPath.name = 'training-path'
  trainingPath.visible = false
  scene.add(trainingPath)

  const replayPath = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xffc978, transparent: true, opacity: 0.72 }),
  )
  replayPath.name = 'replay-path'
  replayPath.visible = false
  scene.add(replayPath)

  const applyState = (state: DroneState): void => {
    drone.position.set(state.positionM.x, state.positionM.y, state.positionM.z)
    drone.quaternion.set(
      state.orientation.x,
      state.orientation.y,
      state.orientation.z,
      state.orientation.w,
    ).normalize()
  }

  const applyGhost = (state: Pick<ReplayGhostState, 'positionM' | 'orientation'>): void => {
    ghost.position.set(state.positionM.x, state.positionM.y, state.positionM.z)
    ghost.quaternion.set(
      state.orientation.x,
      state.orientation.y,
      state.orientation.z,
      state.orientation.w,
    ).normalize()
  }

  const setReplayVisible = (visible: boolean): void => {
    ghost.visible = visible
    if (!visible) replayPath.visible = false
  }

  const setLessonTarget = (lessonId: string | null): void => {
    takeoffHeightTarget.visible = lessonId === 'takeoff'
    landingTarget.visible = lessonId === 'landing'
    straightTargets.visible = lessonId === 'straight-line'
    const beginner = ['takeoff', 'landing', 'straight-line'].includes(lessonId ?? '')
    for (const reference of referenceSet.contract) {
      reference.object.visible = !beginner
    }
  }

  const setPath = (line: THREE.Line, path: readonly Vector3[], yOffset: number): void => {
    const maximumPoints = 1_200
    const stride = Math.max(1, Math.ceil(path.length / maximumPoints))
    const points: THREE.Vector3[] = []
    for (let index = 0; index < path.length; index += stride) {
      const position = path[index]
      if (!position) continue
      points.push(new THREE.Vector3(position.x, position.y + yOffset, position.z))
    }
    const last = path[path.length - 1]
    if (last && (points.length === 0 || points[points.length - 1].x !== last.x || points[points.length - 1].y !== last.y || points[points.length - 1].z !== last.z)) {
      points.push(new THREE.Vector3(last.x, last.y + yOffset, last.z))
    }
    line.geometry.dispose()
    line.geometry = new THREE.BufferGeometry().setFromPoints(points)
    line.visible = points.length >= 2
  }

  const setTrainingPath = (path: readonly Vector3[]): void => {
    setPath(trainingPath, path, 0.04)
  }

  const setReplayPath = (path: readonly Vector3[]): void => {
    setPath(replayPath, path, 0.07)
  }

  return {
    scene,
    drone,
    ghost,
    ground,
    grid,
    takeoffPad,
    references: referenceSet.objects,
    sceneReferences,
    getReference: (id: string): FlightSceneReference | null => referenceById.get(id) ?? null,
    applyState,
    applyGhost,
    setReplayVisible,
    setLessonTarget,
    setTrainingPath,
    setReplayPath,
    dispose: () => disposeFlightScene(scene),
  }
}
