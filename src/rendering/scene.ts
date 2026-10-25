import * as THREE from 'three'

import type { DroneConfig, DroneState } from '../drone'
import { DEFAULT_DRONE_CONFIG, DRONE_GEOMETRY } from '../drone'
import { createTrainingFieldAnchors } from '../training/field'
import { STRAIGHT_LINE_BRAKE_ZONE_START_M, STRAIGHT_LINE_GATE_RADIUS_M, STRAIGHT_LINE_ROUTE_LENGTH_M, STRAIGHT_LINE_TRANSIT_DISTANCE_M } from '../training/straightLine'
import { LANDING_ZONE_RADIUS_M } from '../training/landing'
import { createDirectionControlTargets, DIRECTION_CONTROL_TARGET_RADIUS_M } from '../training/directionControl'
import { createCoordinatedTurnTargets, COORDINATED_TURN_TARGET_RADIUS_M } from '../training/coordinatedTurn'
import { createSquareRouteTargets, SQUARE_ROUTE_TARGET_RADIUS_M } from '../training/squareRoute'
import { createFigureEightTargets, FIGURE_EIGHT_TARGET_RADIUS_M } from '../training/figureEight'
import { BASIC_RECOVERY_AREA_RADIUS_M, BASIC_RECOVERY_MIN_PREPARATION_HEIGHT_M, BASIC_RECOVERY_TARGET_HEIGHT_M } from '../training/basicRecovery'
import { FULL_ROLL_AREA_RADIUS_M, FULL_ROLL_MIN_PREPARATION_HEIGHT_M, FULL_ROLL_TARGET_HEIGHT_M } from '../training/fullRoll'
import { FULL_FLIP_AREA_RADIUS_M, FULL_FLIP_MIN_PREPARATION_HEIGHT_M, FULL_FLIP_TARGET_HEIGHT_M } from '../training/fullFlip'
import { createWideGates, WIDE_GATE_FRAME_DEPTH_M } from '../world/wideGates'
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
  /** Select a single L05 guide; null hides the active instructional marker. */
  setDirectionTarget(targetId: string | null): void
  /** Select a single L06 arrival guide; null hides the current target. */
  setTurnTarget(targetId: string | null): void
  /** Select a single L07 guide; null hides the active square-route target. */
  setSquareTarget(targetId: string | null): void
  /** Select one L08 guide, including the distinct visits to the shared center. */
  setFigureEightTarget(targetId: string | null): void
  /** Select L09 guidance while keeping every physical gate frame visible. */
  setWideGateTarget(targetId: string | null): void
  /** Color a presentation-only L10 stage; null hides its accent, not the area. */
  setRecoveryStage(stage: number | null): void
  /** Color the full-roll guide without changing the drone or its control inputs. */
  setFullRollStage(stage: number | null): void
  /** Color world-fixed pitch-flip guidance without writing flight state. */
  setFullFlipStage(stage: number | null): void
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
  const landingPaint = new THREE.Mesh(new THREE.RingGeometry(0.03, LANDING_ZONE_RADIUS_M, 64), new THREE.MeshBasicMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }))
  landingPaint.name = 'landing-zone-paint'
  landingPaint.rotation.x = -Math.PI / 2
  landingPaint.position.y = 0.015
  const landingRim = new THREE.Mesh(new THREE.RingGeometry(LANDING_ZONE_RADIUS_M, LANDING_ZONE_RADIUS_M + 0.11, 64), new THREE.MeshBasicMaterial({ color: 0x45d7f7, side: THREE.DoubleSide }))
  landingRim.rotation.x = -Math.PI / 2
  landingRim.position.y = 0.018
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 3.6, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }))
  beacon.name = 'landing-beacon'
  beacon.position.y = 1.8
  landingTarget.add(landingPaint, landingRim, beacon)
  const postOffset = LANDING_ZONE_RADIUS_M + 0.2
  for (const [x, z] of [[-postOffset, -postOffset], [postOffset, -postOffset], [-postOffset, postOffset], [postOffset, postOffset]]) {
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
    const horizontal = id === 'straight-start'
    const ring = new THREE.Mesh(new THREE.RingGeometry(STRAIGHT_LINE_GATE_RADIUS_M, STRAIGHT_LINE_GATE_RADIUS_M + 0.08, 64), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }))
    ring.name = `${id}-ring`
    if (horizontal) {
      ring.rotation.x = -Math.PI / 2
    }
    marker.add(ring)
    straightTargets.add(marker)
    const diameter = STRAIGHT_LINE_GATE_RADIUS_M * 2
    routeReferences.push({ id, kind: 'zone', object: marker, positionM: { x: marker.position.x, y: marker.position.y, z: marker.position.z }, sizeM: horizontal ? { x: diameter, y: 0.08, z: diameter } : { x: diameter, y: diameter, z: 0.08 } })
  }
  scene.add(straightTargets)
  const directionTargets = new THREE.Group()
  directionTargets.name = 'direction-control-targets'
  directionTargets.visible = false
  const directionReferences: FlightSceneReference[] = []
  for (const target of createDirectionControlTargets(field.launch, config.ground.heightM)) {
    const marker = new THREE.Group()
    marker.name = `${target.id}-zone`
    marker.position.set(target.positionM.x, target.positionM.y, target.positionM.z)
    marker.visible = false
    const color = target.kind === 'yaw' ? 0xffc978 : 0x45d7f7
    // Three orthogonal outlines describe the actual spherical arrival zone,
    // rather than suggesting another directional gate or a solid obstacle.
    for (const [index, rotation] of [[0, 0], [Math.PI / 2, 0], [0, Math.PI / 2]].entries()) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(DIRECTION_CONTROL_TARGET_RADIUS_M, DIRECTION_CONTROL_TARGET_RADIUS_M + 0.045, 64),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false }),
      )
      ring.name = `${target.id}-outline-${index}`
      ring.rotation.set(rotation[0], rotation[1], 0)
      marker.add(ring)
    }
    const groundOffset = config.ground.heightM - target.positionM.y
    const paint = new THREE.Mesh(
      new THREE.RingGeometry(0.04, DIRECTION_CONTROL_TARGET_RADIUS_M, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
    )
    paint.name = `${target.id}-ground-paint`
    paint.rotation.x = -Math.PI / 2
    paint.position.y = groundOffset + 0.018
    marker.add(paint)

    const beaconHeight = target.positionM.y - config.ground.heightM
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, beaconHeight, 8, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
    )
    beacon.name = `${target.id}-beacon`
    beacon.position.y = groundOffset / 2
    marker.add(beacon)

    const heading = new THREE.ArrowHelper(
      new THREE.Vector3(target.headingForward.x, target.headingForward.y, target.headingForward.z).normalize(),
      new THREE.Vector3(0, 0, 0),
      1.2,
      color,
      0.38,
      0.24,
    )
    heading.name = `${target.id}-heading`
    marker.add(heading)
    if (target.kind === 'yaw') {
      const turnPoints: THREE.Vector3[] = []
      for (let index = 0; index <= 24; index++) {
        const angle = index / 24 * Math.PI / 2
        turnPoints.push(new THREE.Vector3(Math.sin(angle) * 0.9, 0.04, -Math.cos(angle) * 0.9))
      }
      const turnArc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(turnPoints), new THREE.LineBasicMaterial({ color }))
      turnArc.name = 'direction-yaw-turn-arc'
      marker.add(turnArc)
    }
    directionTargets.add(marker)
    const diameter = DIRECTION_CONTROL_TARGET_RADIUS_M * 2
    directionReferences.push({ id: target.id, kind: 'zone', object: marker, positionM: { ...target.positionM }, sizeM: { x: diameter, y: diameter, z: diameter } })
  }
  scene.add(directionTargets)

  const turnTargets = new THREE.Group()
  turnTargets.name = 'coordinated-turn-targets'
  turnTargets.visible = false
  const turnReferences: FlightSceneReference[] = []
  const turnLayout = createCoordinatedTurnTargets(field.launch, config.ground.heightM)
  const turnColors = { right: 0xffc978, left: 0x45d7f7 } as const
  for (const [targetIndex, target] of turnLayout.entries()) {
    const marker = new THREE.Group()
    marker.name = `${target.id}-zone`
    marker.position.set(target.positionM.x, target.positionM.y, target.positionM.z)
    marker.visible = targetIndex === 0
    const color = turnColors[target.direction]
    for (const [index, rotation] of [[0, 0], [Math.PI / 2, 0], [0, Math.PI / 2]].entries()) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(COORDINATED_TURN_TARGET_RADIUS_M, COORDINATED_TURN_TARGET_RADIUS_M + 0.045, 64),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
      )
      ring.name = `${target.id}-outline-${index}`
      ring.rotation.set(rotation[0], rotation[1], 0)
      marker.add(ring)
    }
    const groundOffset = config.ground.heightM - target.positionM.y
    const paint = new THREE.Mesh(
      new THREE.RingGeometry(0.04, COORDINATED_TURN_TARGET_RADIUS_M, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
    )
    paint.name = `${target.id}-ground-paint`
    paint.rotation.x = -Math.PI / 2
    paint.position.y = groundOffset + 0.018
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, -groundOffset, 8, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
    )
    beacon.name = `${target.id}-beacon`
    beacon.position.y = groundOffset / 2
    const heading = new THREE.ArrowHelper(
      new THREE.Vector3(target.headingForward.x, target.headingForward.y, target.headingForward.z).normalize(),
      new THREE.Vector3(), 1.4, color, 0.4, 0.26,
    )
    heading.name = `${target.id}-heading`
    marker.add(paint, beacon, heading)
    turnTargets.add(marker)
    const diameter = COORDINATED_TURN_TARGET_RADIUS_M * 2
    turnReferences.push({ id: target.id, kind: 'zone', object: marker, positionM: { ...target.positionM }, sizeM: { x: diameter, y: diameter, z: diameter } })
  }
  scene.add(turnTargets)

  // The ground trace previews the two bends. It is a guide, never a collider
  // or a corridor that can reset the learner's completed checkpoints.
  const turnRoute = new THREE.Group()
  turnRoute.name = 'coordinated-turn-route'
  turnRoute.visible = false
  for (const direction of ['right', 'left'] as const) {
    const targets = turnLayout.filter((target) => target.direction === direction)
    const start = direction === 'right' ? field.launch : turnLayout[2].positionM
    const points = [start, ...targets.map((target) => target.positionM)]
      .map((point) => new THREE.Vector3(point.x, config.ground.heightM + 0.025, point.z))
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal')
    const route = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(curve.getPoints(64)),
      new THREE.LineDashedMaterial({ color: turnColors[direction], transparent: true, opacity: 0.38, dashSize: 0.7, gapSize: 0.4, depthWrite: false }),
    )
    route.name = `coordinated-turn-${direction}-route`
    route.computeLineDistances()
    turnRoute.add(route)
  }
  scene.add(turnRoute)
  const squareTargets = new THREE.Group()
  squareTargets.name = 'square-route-targets'
  squareTargets.visible = false
  const squareReferences: FlightSceneReference[] = []
  const squareLayout = createSquareRouteTargets(field.launch, config.ground.heightM)
  for (const [targetIndex, target] of squareLayout.entries()) {
    const marker = new THREE.Group()
    marker.name = `${target.id}-zone`
    marker.position.set(target.positionM.x, target.positionM.y, target.positionM.z)
    marker.visible = targetIndex === 0
    const color = target.kind === 'finish' ? 0xb8f36b : target.kind === 'corner' ? 0xffc978 : 0x45d7f7
    for (const [index, rotation] of [[0, 0], [Math.PI / 2, 0], [0, Math.PI / 2]].entries()) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(SQUARE_ROUTE_TARGET_RADIUS_M, SQUARE_ROUTE_TARGET_RADIUS_M + 0.045, 64),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
      )
      ring.name = `${target.id}-outline-${index}`
      ring.rotation.set(rotation[0], rotation[1], 0)
      marker.add(ring)
    }
    const groundOffset = config.ground.heightM - target.positionM.y
    const paint = new THREE.Mesh(
      new THREE.RingGeometry(0.04, SQUARE_ROUTE_TARGET_RADIUS_M, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
    )
    paint.name = `${target.id}-ground-paint`
    paint.rotation.x = -Math.PI / 2
    paint.position.y = groundOffset + 0.018
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, -groundOffset, 8, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
    )
    beacon.name = `${target.id}-beacon`
    beacon.position.y = groundOffset / 2
    const heading = new THREE.ArrowHelper(
      new THREE.Vector3(target.headingForward.x, target.headingForward.y, target.headingForward.z).normalize(),
      new THREE.Vector3(), 1.4, color, 0.4, 0.26,
    )
    heading.name = `${target.id}-heading`
    marker.add(paint, beacon, heading)
    squareTargets.add(marker)
    const diameter = SQUARE_ROUTE_TARGET_RADIUS_M * 2
    squareReferences.push({ id: target.id, kind: 'zone', object: marker, positionM: { ...target.positionM }, sizeM: { x: diameter, y: diameter, z: diameter } })
  }
  scene.add(squareTargets)

  // A faint ground outline previews all four legs without imposing a corridor.
  const squarePath = new THREE.Group()
  squarePath.name = 'square-route-path'
  squarePath.visible = false
  const squareCorners = squareLayout.filter((target) => target.kind !== 'leg')
  const squarePoints = [field.launch, ...squareCorners.map((target) => target.positionM)]
    .map((point) => new THREE.Vector3(point.x, config.ground.heightM + 0.025, point.z))
  const squareGuide = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(squarePoints),
    new THREE.LineDashedMaterial({ color: 0x8abac4, transparent: true, opacity: 0.34, dashSize: 0.7, gapSize: 0.4, depthWrite: false }),
  )
  squareGuide.name = 'square-route-guide'
  squareGuide.computeLineDistances()
  squarePath.add(squareGuide)
  scene.add(squarePath)

  const figureEightTargets = new THREE.Group()
  figureEightTargets.name = 'figure-eight-targets'
  figureEightTargets.visible = false
  const figureEightReferences: FlightSceneReference[] = []
  const figureEightLayout = createFigureEightTargets(field.launch, config.ground.heightM)
  for (const [targetIndex, target] of figureEightLayout.entries()) {
    const marker = new THREE.Group()
    marker.name = `${target.id}-zone`
    marker.position.set(target.positionM.x, target.positionM.y, target.positionM.z)
    marker.visible = targetIndex === 0
    const color = target.kind === 'finish' ? 0xb8f36b : target.kind === 'crossing' ? 0xd28bff
      : target.kind === 'entry' ? 0x8abac4 : target.loop === 1 ? 0xffc978 : 0x45d7f7
    for (const [index, rotation] of [[0, 0], [Math.PI / 2, 0], [0, Math.PI / 2]].entries()) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(FIGURE_EIGHT_TARGET_RADIUS_M, FIGURE_EIGHT_TARGET_RADIUS_M + 0.045, 64),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
      )
      ring.name = `${target.id}-outline-${index}`
      ring.rotation.set(rotation[0], rotation[1], 0)
      marker.add(ring)
    }
    const groundOffset = config.ground.heightM - target.positionM.y
    const paint = new THREE.Mesh(
      new THREE.RingGeometry(0.04, FIGURE_EIGHT_TARGET_RADIUS_M, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
    )
    paint.name = `${target.id}-ground-paint`
    paint.rotation.x = -Math.PI / 2
    paint.position.y = groundOffset + 0.018
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, -groundOffset, 8, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
    )
    beacon.name = `${target.id}-beacon`
    beacon.position.y = groundOffset / 2
    const heading = new THREE.ArrowHelper(
      new THREE.Vector3(target.headingForward.x, target.headingForward.y, target.headingForward.z).normalize(),
      new THREE.Vector3(), 1.4, color, 0.4, 0.26,
    )
    heading.name = `${target.id}-heading`
    marker.add(paint, beacon, heading)
    figureEightTargets.add(marker)
    const diameter = FIGURE_EIGHT_TARGET_RADIUS_M * 2
    figureEightReferences.push({ id: target.id, kind: 'zone', object: marker, positionM: { ...target.positionM }, sizeM: { x: diameter, y: diameter, z: diameter } })
  }
  scene.add(figureEightTargets)

  // Each loop returns to the shared center. The faint route is presentation
  // guidance; completing it still depends on the ordered airborne targets.
  const figureEightPath = new THREE.Group()
  figureEightPath.name = 'figure-eight-path'
  figureEightPath.visible = false
  for (const [loopIndex, loopTargets] of [figureEightLayout.slice(0, 5), figureEightLayout.slice(4)].entries()) {
    const points = loopTargets.map((target) => new THREE.Vector3(target.positionM.x, config.ground.heightM + 0.025, target.positionM.z))
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal')
    const guide = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(curve.getPoints(64)),
      new THREE.LineDashedMaterial({ color: loopIndex === 0 ? 0xffc978 : 0x45d7f7, transparent: true, opacity: 0.36, dashSize: 0.7, gapSize: 0.4, depthWrite: false }),
    )
    guide.name = `figure-eight-${loopIndex === 0 ? 'left' : 'right'}-guide`
    guide.computeLineDistances()
    figureEightPath.add(guide)
  }
  scene.add(figureEightPath)

  // These boxes use the same layout as the collision world. Passing a gate
  // only advances its guidance; its physical frame remains in the course.
  const wideGateField = new THREE.Group()
  wideGateField.name = 'wide-gate-field'
  wideGateField.visible = false
  const wideGateReferences: FlightSceneReference[] = []
  const wideGateGuides = new Map<string, THREE.Group>()
  const wideGateColors = [0x45d7f7, 0xffc978, 0xb8f36b]
  for (const [index, gate] of createWideGates(field.launch, config.ground.heightM).entries()) {
    const frame = new THREE.Group()
    frame.name = `${gate.id}-frame`
    frame.position.set(gate.positionM.x, gate.positionM.y, gate.positionM.z)
    const color = wideGateColors[index]
    for (const collider of gate.colliders) {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(collider.halfExtentsM.x * 2, collider.halfExtentsM.y * 2, collider.halfExtentsM.z * 2),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.18, roughness: 0.65 }),
      )
      box.name = collider.id
      box.position.set(collider.centerM.x - gate.positionM.x, collider.centerM.y - gate.positionM.y, collider.centerM.z - gate.positionM.z)
      frame.add(box)
    }

    const guidance = new THREE.Group()
    guidance.name = `${gate.id}-guidance`
    guidance.visible = index === 0
    const halfWidth = gate.openingWidthM / 2
    const halfHeight = gate.openingHeightM / 2
    const guideDepth = WIDE_GATE_FRAME_DEPTH_M / 2 + 0.025
    const opening = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-halfWidth, -halfHeight, guideDepth),
        new THREE.Vector3(halfWidth, -halfHeight, guideDepth),
        new THREE.Vector3(halfWidth, halfHeight, guideDepth),
        new THREE.Vector3(-halfWidth, halfHeight, guideDepth),
      ]),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false }),
    )
    opening.name = `${gate.id}-opening-guide`
    const heading = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 0.6), 1.4, color, 0.35, 0.24)
    heading.name = `${gate.id}-heading`
    guidance.add(opening, heading)
    frame.add(guidance)
    wideGateGuides.set(gate.id, guidance)
    wideGateField.add(frame)
    wideGateReferences.push({ id: gate.id, kind: 'gate', object: frame, positionM: { ...gate.positionM }, sizeM: { x: gate.openingWidthM, y: gate.openingHeightM, z: WIDE_GATE_FRAME_DEPTH_M } })
  }
  scene.add(wideGateField)

  // L10 supplies visual room and a world-horizontal reference, with no solid
  // planes or physical obstacles. Its center follows the supported launch X/Z.
  const recoveryField = new THREE.Group()
  recoveryField.name = 'basic-recovery-field'
  recoveryField.position.set(field.launch.x, config.ground.heightM + BASIC_RECOVERY_TARGET_HEIGHT_M, field.launch.z)
  recoveryField.visible = false
  const recoveryFloor = new THREE.Mesh(
    new THREE.RingGeometry(BASIC_RECOVERY_AREA_RADIUS_M - 0.07, BASIC_RECOVERY_AREA_RADIUS_M, 128),
    new THREE.MeshBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
  )
  recoveryFloor.name = 'recovery-area-boundary'
  recoveryFloor.rotation.x = -Math.PI / 2
  recoveryFloor.position.y = -BASIC_RECOVERY_TARGET_HEIGHT_M + 0.025
  recoveryField.add(recoveryFloor)

  const recoveryHeightPole = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(8, -BASIC_RECOVERY_TARGET_HEIGHT_M, -10), new THREE.Vector3(8, 8.3 - BASIC_RECOVERY_TARGET_HEIGHT_M, -10),
      ...[BASIC_RECOVERY_MIN_PREPARATION_HEIGHT_M, BASIC_RECOVERY_TARGET_HEIGHT_M, 8].flatMap((height) => [
        new THREE.Vector3(7.6, height - BASIC_RECOVERY_TARGET_HEIGHT_M, -10), new THREE.Vector3(8.4, height - BASIC_RECOVERY_TARGET_HEIGHT_M, -10),
      ]),
    ]),
    new THREE.LineBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.7, depthWrite: false }),
  )
  recoveryHeightPole.name = 'recovery-height-pole'
  recoveryField.add(recoveryHeightPole)

  const recoveryHeightBand = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-6, BASIC_RECOVERY_MIN_PREPARATION_HEIGHT_M - BASIC_RECOVERY_TARGET_HEIGHT_M, -12),
      new THREE.Vector3(6, BASIC_RECOVERY_MIN_PREPARATION_HEIGHT_M - BASIC_RECOVERY_TARGET_HEIGHT_M, -12),
      new THREE.Vector3(6, 8 - BASIC_RECOVERY_TARGET_HEIGHT_M, -12),
      new THREE.Vector3(-6, 8 - BASIC_RECOVERY_TARGET_HEIGHT_M, -12),
    ]),
    new THREE.LineBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.25, depthWrite: false }),
  )
  recoveryHeightBand.name = 'recovery-height-band'
  recoveryField.add(recoveryHeightBand)

  const recoveryAccent = new THREE.Group()
  recoveryAccent.name = 'recovery-stage-guidance'
  const recoveryStageMaterial = new THREE.LineBasicMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.9, depthWrite: false })
  const recoveryLevel = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-5, 0, -12), new THREE.Vector3(5, 0, -12),
      new THREE.Vector3(-5, -0.25, -12), new THREE.Vector3(-5, 0.25, -12),
      new THREE.Vector3(5, -0.25, -12), new THREE.Vector3(5, 0.25, -12),
      new THREE.Vector3(0, -0.16, -12), new THREE.Vector3(0, 0.16, -12),
    ]), recoveryStageMaterial,
  )
  recoveryLevel.name = 'recovery-level-reference'
  recoveryAccent.add(recoveryLevel)
  recoveryField.add(recoveryAccent)
  scene.add(recoveryField)

  const recoveryReference: FlightSceneReference = {
    id: 'recovery-zone', kind: 'zone', object: recoveryField,
    positionM: { x: field.launch.x, y: config.ground.heightM + BASIC_RECOVERY_TARGET_HEIGHT_M, z: field.launch.z },
    sizeM: { x: BASIC_RECOVERY_AREA_RADIUS_M * 2, y: 8 - BASIC_RECOVERY_MIN_PREPARATION_HEIGHT_M, z: BASIC_RECOVERY_AREA_RADIUS_M * 2 },
  }

  // World-fixed lines provide an upright reference while the FPV camera rolls.
  // These are visual guides; this open practice area adds no solid obstacles.
  const rollField = new THREE.Group()
  rollField.name = 'full-roll-field'
  rollField.position.set(field.launch.x, config.ground.heightM + FULL_ROLL_TARGET_HEIGHT_M, field.launch.z)
  rollField.visible = false
  const rollFloor = new THREE.Mesh(
    new THREE.RingGeometry(FULL_ROLL_AREA_RADIUS_M - 0.07, FULL_ROLL_AREA_RADIUS_M, 128),
    new THREE.MeshBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }),
  )
  rollFloor.name = 'roll-area-boundary'
  rollFloor.rotation.x = -Math.PI / 2
  rollFloor.position.y = -FULL_ROLL_TARGET_HEIGHT_M + 0.025
  rollField.add(rollFloor)
  const rollGuideTopM = FULL_ROLL_TARGET_HEIGHT_M + 4
  const rollHeightPole = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(10, -FULL_ROLL_TARGET_HEIGHT_M, -16), new THREE.Vector3(10, rollGuideTopM - FULL_ROLL_TARGET_HEIGHT_M, -16),
      ...[FULL_ROLL_MIN_PREPARATION_HEIGHT_M, FULL_ROLL_TARGET_HEIGHT_M, rollGuideTopM].flatMap((height) => [
        new THREE.Vector3(9.5, height - FULL_ROLL_TARGET_HEIGHT_M, -16), new THREE.Vector3(10.5, height - FULL_ROLL_TARGET_HEIGHT_M, -16),
      ]),
    ]),
    new THREE.LineBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.75, depthWrite: false }),
  )
  rollHeightPole.name = 'roll-height-pole'
  rollField.add(rollHeightPole)
  const rollHeightBand = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-8, FULL_ROLL_MIN_PREPARATION_HEIGHT_M - FULL_ROLL_TARGET_HEIGHT_M, -16),
      new THREE.Vector3(8, FULL_ROLL_MIN_PREPARATION_HEIGHT_M - FULL_ROLL_TARGET_HEIGHT_M, -16),
      new THREE.Vector3(8, rollGuideTopM - FULL_ROLL_TARGET_HEIGHT_M, -16),
      new THREE.Vector3(-8, rollGuideTopM - FULL_ROLL_TARGET_HEIGHT_M, -16),
    ]),
    new THREE.LineBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.25, depthWrite: false }),
  )
  rollHeightBand.name = 'roll-height-band'
  rollField.add(rollHeightBand)
  const rollAccent = new THREE.Group()
  rollAccent.name = 'roll-stage-guidance'
  const rollStageMaterial = new THREE.LineBasicMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.95, depthWrite: false })
  const rollLevel = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-8, 0, -16), new THREE.Vector3(8, 0, -16),
      new THREE.Vector3(-8, -0.4, -16), new THREE.Vector3(-8, 0.4, -16),
      new THREE.Vector3(8, -0.4, -16), new THREE.Vector3(8, 0.4, -16),
      new THREE.Vector3(0, -0.2, -16), new THREE.Vector3(0, 0.2, -16),
    ]), rollStageMaterial,
  )
  rollLevel.name = 'roll-level-reference'
  const rollUpMaterial = rollStageMaterial.clone()
  const rollUp = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.6, -16), new THREE.Vector3(0, 2, -16),
      new THREE.Vector3(-0.6, 1.4, -16), new THREE.Vector3(0, 2, -16),
      new THREE.Vector3(0.6, 1.4, -16), new THREE.Vector3(0, 2, -16),
    ]), rollUpMaterial,
  )
  rollUp.name = 'roll-world-up-reference'
  rollAccent.add(rollLevel, rollUp)
  rollField.add(rollAccent)
  scene.add(rollField)
  const rollReference: FlightSceneReference = {
    id: 'roll-zone', kind: 'zone', object: rollField,
    positionM: { x: field.launch.x, y: config.ground.heightM + FULL_ROLL_TARGET_HEIGHT_M, z: field.launch.z },
    sizeM: { x: FULL_ROLL_AREA_RADIUS_M * 2, y: rollGuideTopM - FULL_ROLL_MIN_PREPARATION_HEIGHT_M, z: FULL_ROLL_AREA_RADIUS_M * 2 },
  }

  // World-fixed lines provide an upright reference while the FPV camera pitches.
  // These are visual guides; this open practice area adds no solid obstacles.
  const flipField = new THREE.Group()
  flipField.name = 'full-flip-field'
  flipField.position.set(field.launch.x, config.ground.heightM + FULL_FLIP_TARGET_HEIGHT_M, field.launch.z)
  flipField.visible = false
  const flipFloor = new THREE.Mesh(
    new THREE.RingGeometry(FULL_FLIP_AREA_RADIUS_M - 0.07, FULL_FLIP_AREA_RADIUS_M, 128),
    new THREE.MeshBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }),
  )
  flipFloor.name = 'flip-area-boundary'
  flipFloor.rotation.x = -Math.PI / 2
  flipFloor.position.y = -FULL_FLIP_TARGET_HEIGHT_M + 0.025
  flipField.add(flipFloor)
  const flipGuideTopM = FULL_FLIP_TARGET_HEIGHT_M + 4
  const flipHeightPole = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(10, -FULL_FLIP_TARGET_HEIGHT_M, -16), new THREE.Vector3(10, flipGuideTopM - FULL_FLIP_TARGET_HEIGHT_M, -16),
      ...[FULL_FLIP_MIN_PREPARATION_HEIGHT_M, FULL_FLIP_TARGET_HEIGHT_M, flipGuideTopM].flatMap((height) => [
        new THREE.Vector3(9.5, height - FULL_FLIP_TARGET_HEIGHT_M, -16), new THREE.Vector3(10.5, height - FULL_FLIP_TARGET_HEIGHT_M, -16),
      ]),
    ]),
    new THREE.LineBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.75, depthWrite: false }),
  )
  flipHeightPole.name = 'flip-height-pole'
  flipField.add(flipHeightPole)
  const flipHeightBand = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-8, FULL_FLIP_MIN_PREPARATION_HEIGHT_M - FULL_FLIP_TARGET_HEIGHT_M, -16),
      new THREE.Vector3(8, FULL_FLIP_MIN_PREPARATION_HEIGHT_M - FULL_FLIP_TARGET_HEIGHT_M, -16),
      new THREE.Vector3(8, flipGuideTopM - FULL_FLIP_TARGET_HEIGHT_M, -16),
      new THREE.Vector3(-8, flipGuideTopM - FULL_FLIP_TARGET_HEIGHT_M, -16),
    ]),
    new THREE.LineBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.25, depthWrite: false }),
  )
  flipHeightBand.name = 'flip-height-band'
  flipField.add(flipHeightBand)
  const flipAccent = new THREE.Group()
  flipAccent.name = 'flip-stage-guidance'
  const flipStageMaterial = new THREE.LineBasicMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.95, depthWrite: false })
  const flipLevel = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-8, 0, -16), new THREE.Vector3(8, 0, -16),
      new THREE.Vector3(-8, -0.4, -16), new THREE.Vector3(-8, 0.4, -16),
      new THREE.Vector3(8, -0.4, -16), new THREE.Vector3(8, 0.4, -16),
      new THREE.Vector3(0, -0.2, -16), new THREE.Vector3(0, 0.2, -16),
    ]), flipStageMaterial,
  )
  flipLevel.name = 'flip-level-reference'
  const flipUpMaterial = flipStageMaterial.clone()
  const flipUp = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.6, -16), new THREE.Vector3(0, 2, -16),
      new THREE.Vector3(-0.6, 1.4, -16), new THREE.Vector3(0, 2, -16),
      new THREE.Vector3(0.6, 1.4, -16), new THREE.Vector3(0, 2, -16),
    ]), flipUpMaterial,
  )
  flipUp.name = 'flip-world-up-reference'
  // The two world-fixed arrows distinguish the launch-forward (-Z) and
  // launch-backward (+Z) sides during a flip. They are thin visual lines,
  // placed at the preparation height rather than a solid plane to fly through.
  const flipDirectionY = FULL_FLIP_MIN_PREPARATION_HEIGHT_M - FULL_FLIP_TARGET_HEIGHT_M
  const flipForwardMaterial = flipStageMaterial.clone()
  const flipBackwardMaterial = flipStageMaterial.clone()
  const flipForward = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, flipDirectionY, -8), new THREE.Vector3(0, flipDirectionY, -14),
      new THREE.Vector3(-0.8, flipDirectionY, -12.4), new THREE.Vector3(0, flipDirectionY, -14),
      new THREE.Vector3(0.8, flipDirectionY, -12.4), new THREE.Vector3(0, flipDirectionY, -14),
    ]), flipForwardMaterial,
  )
  flipForward.name = 'flip-forward-reference'
  const flipBackward = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, flipDirectionY, 8), new THREE.Vector3(0, flipDirectionY, 14),
      new THREE.Vector3(-0.8, flipDirectionY, 12.4), new THREE.Vector3(0, flipDirectionY, 14),
      new THREE.Vector3(0.8, flipDirectionY, 12.4), new THREE.Vector3(0, flipDirectionY, 14),
      new THREE.Vector3(-0.8, flipDirectionY, 10.8), new THREE.Vector3(0, flipDirectionY, 12.4),
      new THREE.Vector3(0.8, flipDirectionY, 10.8), new THREE.Vector3(0, flipDirectionY, 12.4),
    ]), flipBackwardMaterial,
  )
  flipBackward.name = 'flip-backward-reference'
  flipAccent.add(flipLevel, flipUp, flipForward, flipBackward)
  flipField.add(flipAccent)
  scene.add(flipField)
  const flipReference: FlightSceneReference = {
    id: 'flip-zone', kind: 'zone', object: flipField,
    positionM: { x: field.launch.x, y: config.ground.heightM + FULL_FLIP_TARGET_HEIGHT_M, z: field.launch.z },
    sizeM: { x: FULL_FLIP_AREA_RADIUS_M * 2, y: flipGuideTopM - FULL_FLIP_MIN_PREPARATION_HEIGHT_M, z: FULL_FLIP_AREA_RADIUS_M * 2 },
  }

  const landingSurface: FlightSceneReference = { id: 'landing-surface', kind: 'zone', object: landingTarget, positionM: { ...field.landing }, sizeM: { x: LANDING_ZONE_RADIUS_M * 2, y: 0, z: LANDING_ZONE_RADIUS_M * 2 } }
  const launchReference: FlightSceneReference = { id: 'training-launch', kind: 'pad', object: takeoffPad, positionM: { ...field.launch } }
  const sceneReferences = [padReference, ...referenceSet.contract, landingSurface, launchReference, ...routeReferences, ...directionReferences, ...turnReferences, ...squareReferences, ...figureEightReferences, ...wideGateReferences, recoveryReference, rollReference, flipReference]
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
    directionTargets.visible = lessonId === 'direction-control'
    turnTargets.visible = lessonId === 'coordinated-turn'
    turnRoute.visible = lessonId === 'coordinated-turn'
    squareTargets.visible = lessonId === 'square-route'
    squarePath.visible = lessonId === 'square-route'
    figureEightTargets.visible = lessonId === 'figure-eight'
    figureEightPath.visible = lessonId === 'figure-eight'
    wideGateField.visible = lessonId === 'wide-gate'
    recoveryField.visible = lessonId === 'basic-recovery'
    rollField.visible = lessonId === 'full-roll'
    flipField.visible = ['full-flip', 'front-flip', 'back-flip'].includes(lessonId ?? '')
    const beginner = ['takeoff', 'landing', 'straight-line', 'direction-control', 'coordinated-turn', 'square-route', 'figure-eight', 'wide-gate', 'basic-recovery', 'full-roll', 'full-flip', 'front-flip', 'back-flip'].includes(lessonId ?? '')
    for (const reference of referenceSet.contract) {
      reference.object.visible = !beginner
    }
  }

  const setDirectionTarget = (targetId: string | null): void => {
    for (const reference of directionReferences) reference.object.visible = reference.id === targetId
  }

  const setTurnTarget = (targetId: string | null): void => {
    for (const reference of turnReferences) reference.object.visible = reference.id === targetId
  }

  const setSquareTarget = (targetId: string | null): void => {
    for (const reference of squareReferences) reference.object.visible = reference.id === targetId
  }

  const setFigureEightTarget = (targetId: string | null): void => {
    for (const reference of figureEightReferences) reference.object.visible = reference.id === targetId
  }

  const setWideGateTarget = (targetId: string | null): void => {
    for (const [id, guidance] of wideGateGuides) guidance.visible = id === targetId
  }

  const setRecoveryStage = (stage: number | null): void => {
    if (stage === null || !Number.isInteger(stage) || stage < 0 || stage > 8) {
      recoveryAccent.visible = false
      return
    }
    recoveryAccent.visible = true
    recoveryStageMaterial.color.set(stage === 8 ? 0xb8f36b : stage >= 3 && stage % 2 === 1 ? 0xffc978 : 0x45d7f7)
  }

  const setFullRollStage = (stage: number | null): void => {
    if (stage === null || !Number.isInteger(stage) || stage < 0 || stage > 6) {
      rollAccent.visible = false
      return
    }
    rollAccent.visible = true
    const color = stage >= 5 ? 0xb8f36b : stage >= 3 ? 0xffc978 : 0x45d7f7
    rollStageMaterial.color.set(color)
    rollUpMaterial.color.set(color)
  }

  const setFullFlipStage = (stage: number | null): void => {
    if (stage === null || !Number.isInteger(stage) || stage < 0 || stage > 6) {
      flipAccent.visible = false
      return
    }
    flipAccent.visible = true
    const color = stage >= 5 ? 0xb8f36b : stage >= 3 ? 0xffc978 : 0x45d7f7
    flipStageMaterial.color.set(color)
    flipUpMaterial.color.set(color)
    flipForwardMaterial.color.set(color)
    flipBackwardMaterial.color.set(color)
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
    setDirectionTarget,
    setTurnTarget,
    setSquareTarget,
    setFigureEightTarget,
    setWideGateTarget,
    setRecoveryStage,
    setFullRollStage,
    setFullFlipStage,
    setTrainingPath,
    setReplayPath,
    dispose: () => disposeFlightScene(scene),
  }
}
