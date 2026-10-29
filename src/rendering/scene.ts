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
import { POWER_LOOP_AREA_RADIUS_M, POWER_LOOP_TARGET_HEIGHT_M } from '../training/powerLoop'
import { SPLIT_S_AREA_RADIUS_M, SPLIT_S_MIN_HEIGHT_M, SPLIT_S_TARGET_HEIGHT_M } from '../training/splitS'
import { createOrbitTarget, ORBIT_TARGET_HEIGHT_M, ORBIT_TARGET_RADIUS_M, ORBIT_MIN_RADIUS_M, ORBIT_MAX_RADIUS_M, ORBIT_MIN_ENTRY_HEIGHT_M, ORBIT_MAX_ENTRY_HEIGHT_M } from '../training/orbit'
import { BACKWARD_FLIGHT_TARGET_HEIGHT_M } from '../training/backwardFlight'
import { createReverseOrbitTarget, REVERSE_ORBIT_TARGET_HEIGHT_M, REVERSE_ORBIT_FLIGHT_HEIGHT_M, REVERSE_ORBIT_TARGET_RADIUS_M, REVERSE_ORBIT_MIN_RADIUS_M, REVERSE_ORBIT_MAX_RADIUS_M, REVERSE_ORBIT_MIN_ENTRY_HEIGHT_M, REVERSE_ORBIT_MAX_ENTRY_HEIGHT_M } from '../training/reverseOrbit'
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
  /** Highlight an illustrative vertical-loop segment without changing flight. */
  setPowerLoopStage(stage: number | null): void
  /** Show entry, inverted descent and reversed exit without changing flight. */
  setSplitSStage(stage: number | null): void
  /** Highlight ground, entry and lap milestones while leaving the target fixed. */
  setOrbitStage(stage: number | null): void
  /** Show nose-versus-travel guidance without changing actual velocity or heading. */
  setBackwardFlightStage(stage: number | null): void
  /** Highlight the crane, three lap milestones and exit without steering flight. */
  setReverseOrbitStage(stage: number | null): void
  /** Presentation-only bounded path trace; evaluators remain renderer-independent. */
  setTrainingPath(path: readonly Vector3[]): void
  setReplayPath(path: readonly Vector3[]): void
  dispose(): void
}

function material(color: number, roughness = 0.72, metalness = 0.05): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness })
}

/** Original open-lattice crane, readable from underneath without collision geometry. */
function createReverseOrbitCrane(): THREE.Group {
  const crane = new THREE.Group()
  crane.name = 'reverse-orbit-crane'
  crane.userData = { teachingReference: '倒刷鍋塔式起重機與高處機臂', collision: false }
  const steel = material(0xffb13b, 0.58, 0.2)
  steel.emissive.set(0x8c4b0d)
  steel.emissiveIntensity = 0.32
  const darkSteel = material(0x73909a, 0.58, 0.28)
  const bracingMaterial = new THREE.LineBasicMaterial({ color: 0xffc978 })
  const braces: THREE.Vector3[] = []
  const addBrace = (a: THREE.Vector3, b: THREE.Vector3): void => { braces.push(a, b) }
  const beam = (name: string, from: THREE.Vector3, to: THREE.Vector3, radius = 0.13): THREE.Mesh => {
    const offset = to.clone().sub(from)
    const result = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, offset.length(), 6), steel)
    result.name = name
    result.position.copy(from).add(to).multiplyScalar(0.5)
    result.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), offset.normalize())
    return result
  }
  const mast = new THREE.Group()
  mast.name = 'reverse-orbit-crane-mast'
  const low = -REVERSE_ORBIT_TARGET_HEIGHT_M
  const corners = [[-1.05, -1.05], [1.05, -1.05], [1.05, 1.05], [-1.05, 1.05]] as const
  for (const [index, [x, z]] of corners.entries()) {
    mast.add(beam(`reverse-orbit-crane-mast-leg-${index}`, new THREE.Vector3(x, low, z), new THREE.Vector3(x, 0, z), 0.18))
  }
  for (let bottom = low; bottom < -0.01; bottom += 5) {
    const top = Math.min(0, bottom + 5)
    for (let side = 0; side < 4; side += 1) {
      const a = corners[side]
      const b = corners[(side + 1) % 4]
      addBrace(new THREE.Vector3(a[0], bottom, a[1]), new THREE.Vector3(b[0], bottom, b[1]))
      addBrace(new THREE.Vector3(a[0], bottom, a[1]), new THREE.Vector3(b[0], top, b[1]))
      addBrace(new THREE.Vector3(b[0], bottom, b[1]), new THREE.Vector3(a[0], top, a[1]))
    }
  }
  const base = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.45, 4.8), material(0x4a6069))
  base.name = 'reverse-orbit-crane-base'
  base.position.y = low + 0.225
  mast.add(base)
  crane.add(mast)

  const makeJib = (name: string, endX: number): THREE.Group => {
    const jib = new THREE.Group()
    jib.name = name
    const rails = [[0, -1.2], [0, 1.2], [2.2, 0]] as const
    for (const [index, [y, z]] of rails.entries()) {
      jib.add(beam(`${name}-rail-${index}`, new THREE.Vector3(0, y, z), new THREE.Vector3(endX, y, z), 0.17))
    }
    const sections = Math.ceil(Math.abs(endX) / 3)
    for (let index = 0; index < sections; index += 1) {
      const start = endX * index / sections
      const end = endX * (index + 1) / sections
      addBrace(new THREE.Vector3(start, 0, -1.2), new THREE.Vector3(start, 0, 1.2))
      addBrace(new THREE.Vector3(start, 0, -1.2), new THREE.Vector3(end, 0, 1.2))
      addBrace(new THREE.Vector3(start, 0, 1.2), new THREE.Vector3(end, 0, -1.2))
      for (const z of [-1.2, 1.2]) {
        addBrace(new THREE.Vector3(start, 0, z), new THREE.Vector3(end, 2.2, 0))
        addBrace(new THREE.Vector3(start, 2.2, 0), new THREE.Vector3(end, 0, z))
      }
    }
    const underside = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(endX), 0.12, 0.5), steel)
    underside.name = `${name}-underside`
    underside.position.set(endX / 2, -0.08, 0)
    jib.add(underside)
    return jib
  }
  crane.add(makeJib('reverse-orbit-crane-jib', 24), makeJib('reverse-orbit-crane-counter-jib', -10))
  const turntable = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 0.55, 16), darkSteel)
  turntable.name = 'reverse-orbit-crane-turntable'
  turntable.position.y = 0.35
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.8, 1.8), material(0x438da6, 0.38, 0.2))
  cabin.name = 'reverse-orbit-crane-cabin'
  cabin.position.set(2.3, 1.4, 0)
  crane.add(turntable, cabin)
  const headTop = new THREE.Vector3(-0.6, 7.5, 0)
  crane.add(beam('reverse-orbit-crane-head-mast', new THREE.Vector3(-0.6, 1, 0), headTop, 0.15))
  const cables = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
    headTop, new THREE.Vector3(24, 2.2, 0), headTop, new THREE.Vector3(-10, 2.2, 0),
    new THREE.Vector3(18, 0, 0), new THREE.Vector3(18, -5, 0),
  ]), new THREE.LineBasicMaterial({ color: 0xd1e3e7 }))
  cables.name = 'reverse-orbit-crane-support-and-hook-cables'
  crane.add(cables)
  for (let index = 0; index < 3; index += 1) {
    const weight = new THREE.Mesh(new THREE.BoxGeometry(1.25, 2, 2.6), darkSteel)
    weight.name = `reverse-orbit-crane-counterweight-${index}`
    weight.position.set(-8.5 + index * 1.4, -0.6, 0)
    crane.add(weight)
  }
  const hook = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.1, 0.65), steel)
  hook.name = 'reverse-orbit-crane-hook-block'
  hook.position.set(18, -5.3, 0)
  const hookBend = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.09, 6, 12, Math.PI * 1.5), darkSteel)
  hookBend.name = 'reverse-orbit-crane-hook'
  hookBend.position.set(18, -6.05, 0)
  crane.add(hook, hookBend)
  const lattice = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(braces), bracingMaterial)
  lattice.name = 'reverse-orbit-crane-lattice'
  crane.add(lattice)
  return crane
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

function disposeMaterial(materialValue: THREE.Material, textures: Set<THREE.Texture>): void {
  const record = materialValue as THREE.Material & Record<string, unknown>
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object' && 'isTexture' in value && typeof (value as THREE.Texture).dispose === 'function') {
      const texture = value as THREE.Texture
      if (!textures.has(texture)) {
        textures.add(texture)
        texture.dispose()
      }
    }
  }
  materialValue.dispose()
}

function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (mesh.geometry && typeof mesh.geometry.dispose === 'function' && !geometries.has(mesh.geometry)) {
      geometries.add(mesh.geometry)
      mesh.geometry.dispose()
    }
    const objectMaterials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    for (const materialValue of objectMaterials) {
      if (!materials.has(materialValue)) {
        materials.add(materialValue)
        disposeMaterial(materialValue, textures)
      }
    }
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

  // These dashed outlines illustrate the shape and order of a vertical loop.
  // They are non-solid references, not gates or a mandatory scored flight path.
  // The evaluator measures the learner's own entry plane and actual movement.
  const loopField = new THREE.Group()
  loopField.name = 'power-loop-field'
  loopField.position.set(field.launch.x, config.ground.heightM + POWER_LOOP_TARGET_HEIGHT_M, field.launch.z)
  loopField.visible = false
  const loopFloor = new THREE.Mesh(
    new THREE.RingGeometry(POWER_LOOP_AREA_RADIUS_M - 0.07, POWER_LOOP_AREA_RADIUS_M, 128),
    new THREE.MeshBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }),
  )
  loopFloor.name = 'loop-area-boundary'
  loopFloor.rotation.x = -Math.PI / 2
  loopFloor.position.y = -POWER_LOOP_TARGET_HEIGHT_M + 0.025
  loopField.add(loopFloor)
  for (const [side, x] of [['left', -5], ['right', 5]] as const) {
    const points = Array.from({ length: 97 }, (_, index) => {
      const angle = index / 96 * Math.PI * 2
      return new THREE.Vector3(x, 8 - 8 * Math.cos(angle), -18 - 8 * Math.sin(angle))
    })
    const outline = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineDashedMaterial({ color: 0x8abac4, transparent: true, opacity: 0.45, dashSize: 0.8, gapSize: 0.7, depthWrite: false }),
    )
    outline.name = `loop-outline-${side}`
    outline.computeLineDistances()
    loopField.add(outline)
  }
  const loopHeightPole = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      ...[-7, 7].flatMap((x) => [
        new THREE.Vector3(x, -POWER_LOOP_TARGET_HEIGHT_M, -18), new THREE.Vector3(x, 16, -18),
        ...[0, 8, 16].flatMap((y) => [new THREE.Vector3(x - 0.5, y, -18), new THREE.Vector3(x + 0.5, y, -18)]),
      ]),
    ]),
    new THREE.LineBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.4, depthWrite: false }),
  )
  loopHeightPole.name = 'loop-height-poles'
  loopField.add(loopHeightPole)
  const loopAccent = new THREE.Group()
  loopAccent.name = 'loop-stage-guidance'
  loopAccent.position.set(0, 0, -18)
  const loopStageMaterial = new THREE.LineBasicMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.95, depthWrite: false })
  const loopStageReference = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-5, 0, 0), new THREE.Vector3(5, 0, 0),
      new THREE.Vector3(-5, -0.5, 0), new THREE.Vector3(-5, 0.5, 0),
      new THREE.Vector3(5, -0.5, 0), new THREE.Vector3(5, 0.5, 0),
      new THREE.Vector3(0, 0.6, 0), new THREE.Vector3(0, 2, 0),
      new THREE.Vector3(-0.6, 1.4, 0), new THREE.Vector3(0, 2, 0),
      new THREE.Vector3(0.6, 1.4, 0), new THREE.Vector3(0, 2, 0),
    ]), loopStageMaterial,
  )
  loopStageReference.name = 'loop-stage-reference'
  loopAccent.add(loopStageReference)
  loopField.add(loopAccent)
  scene.add(loopField)
  const loopReference: FlightSceneReference = {
    id: 'loop-zone', kind: 'zone', object: loopField,
    positionM: { x: field.launch.x, y: config.ground.heightM + POWER_LOOP_TARGET_HEIGHT_M, z: field.launch.z },
    sizeM: { x: POWER_LOOP_AREA_RADIUS_M * 2, y: 16, z: POWER_LOOP_AREA_RADIUS_M * 2 },
  }

  // A broad visual gantry makes the over / far side / under relationship
  // readable. It does not add collision geometry or a mandatory scored route.
  // The pilot can still use another entry heading for the same maneuver.
  const splitField = new THREE.Group()
  splitField.name = 'split-s-field'
  splitField.position.set(field.launch.x, config.ground.heightM + SPLIT_S_TARGET_HEIGHT_M, field.launch.z)
  splitField.visible = false
  const splitFloor = new THREE.Mesh(
    new THREE.RingGeometry(SPLIT_S_AREA_RADIUS_M - 0.07, SPLIT_S_AREA_RADIUS_M, 128),
    new THREE.MeshBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }),
  )
  splitFloor.name = 'split-area-boundary'
  splitFloor.rotation.x = -Math.PI / 2
  splitFloor.position.y = -SPLIT_S_TARGET_HEIGHT_M + 0.025
  splitField.add(splitFloor)
  const splitBeamZ = -40
  const splitPathZ = splitBeamZ - 4
  const splitPathRadiusM = 8
  const splitExitY = -splitPathRadiusM * 2
  const splitGantry = new THREE.Group()
  splitGantry.name = 'split-reference-gantry'
  splitGantry.userData = { teachingReference: '破S 參考橫樑', collision: false }
  const addSplitReferenceBox = (name: string, size: readonly [number, number, number], position: readonly [number, number, number], color: number): THREE.Mesh => {
    const referenceMaterial = material(color, 0.7, 0.12)
    referenceMaterial.emissive.set(color)
    referenceMaterial.emissiveIntensity = 0.18
    const box = new THREE.Mesh(new THREE.BoxGeometry(...size), referenceMaterial)
    box.name = name
    box.position.set(...position)
    splitGantry.add(box)
    return box
  }
  addSplitReferenceBox('split-reference-beam', [22, 1, 2], [0, 18 - SPLIT_S_TARGET_HEIGHT_M, splitBeamZ], 0xffba52)
  for (const [side, x] of [['left', -10], ['right', 10]] as const) {
    addSplitReferenceBox(`split-reference-post-${side}`, [1, 18, 1.5], [x, 9 - SPLIT_S_TARGET_HEIGHT_M, splitBeamZ], 0x668691)
    addSplitReferenceBox(`split-reference-foot-${side}`, [3, 0.35, 3], [x, 0.175 - SPLIT_S_TARGET_HEIGHT_M, splitBeamZ], 0x40565f)
  }
  // Opaque alternating marks give the broad beam a recognizable front and back
  // even while inverted, rather than reading as another translucent path line.
  for (const [index, x] of [-9.8, -7, -4.2, -1.4, 1.4, 4.2, 7, 9.8].entries()) {
    for (const [side, z] of [['front', splitBeamZ + 1.025], ['back', splitBeamZ - 1.025]] as const) {
      const stripe = addSplitReferenceBox(`split-reference-stripe-${side}-${index}`, [0.5, 0.74, 0.04], [x, 18 - SPLIT_S_TARGET_HEIGHT_M, z], 0x23373d)
      stripe.rotation.z = Math.PI / 8
    }
  }
  splitField.add(splitGantry)
  for (const [side, x] of [['left', -5], ['right', 5]] as const) {
    const points = Array.from({ length: 49 }, (_, index) => {
      const angle = index / 48 * Math.PI
      return new THREE.Vector3(x, splitPathRadiusM * Math.cos(angle) - splitPathRadiusM, splitPathZ - splitPathRadiusM * Math.sin(angle))
    })
    const outline = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineDashedMaterial({ color: 0x8abac4, transparent: true, opacity: 0.5, dashSize: 0.8, gapSize: 0.7, depthWrite: false }),
    )
    outline.name = `split-outline-${side}`
    outline.computeLineDistances()
    splitField.add(outline)
  }
  const splitHeightPoles = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([-7, 7].flatMap((x) => [
      new THREE.Vector3(x, -SPLIT_S_TARGET_HEIGHT_M, splitPathZ), new THREE.Vector3(x, 1, splitPathZ),
      ...[SPLIT_S_MIN_HEIGHT_M - SPLIT_S_TARGET_HEIGHT_M, splitExitY, 0].flatMap((y) => [
        new THREE.Vector3(x - 0.5, y, splitPathZ), new THREE.Vector3(x + 0.5, y, splitPathZ),
      ]),
    ])),
    new THREE.LineBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.45, depthWrite: false }),
  )
  splitHeightPoles.name = 'split-height-poles'
  splitField.add(splitHeightPoles)
  const splitEntryBand = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-6, 0, splitBeamZ + 4), new THREE.Vector3(-6, 0, splitPathZ - 2),
      new THREE.Vector3(6, 0, splitPathZ - 2), new THREE.Vector3(6, 0, splitBeamZ + 4),
    ]),
    new THREE.LineDashedMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.55, dashSize: 0.7, gapSize: 0.6, depthWrite: false }),
  )
  splitEntryBand.name = 'split-entry-height-band'
  splitEntryBand.computeLineDistances()
  splitField.add(splitEntryBand)
  const splitApproach = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, splitBeamZ + 12), new THREE.Vector3(0, 0, splitPathZ),
      new THREE.Vector3(-1, 0, splitPathZ + 2), new THREE.Vector3(0, 0, splitPathZ),
      new THREE.Vector3(1, 0, splitPathZ + 2), new THREE.Vector3(0, 0, splitPathZ),
    ]),
    new THREE.LineBasicMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.55, depthWrite: false }),
  )
  splitApproach.name = 'split-over-beam-approach'
  splitField.add(splitApproach)
  const splitExit = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, splitExitY, splitPathZ), new THREE.Vector3(0, splitExitY, splitBeamZ + 8),
      new THREE.Vector3(-1, splitExitY, splitBeamZ + 6), new THREE.Vector3(0, splitExitY, splitBeamZ + 8),
      new THREE.Vector3(1, splitExitY, splitBeamZ + 6), new THREE.Vector3(0, splitExitY, splitBeamZ + 8),
    ]),
    new THREE.LineBasicMaterial({ color: 0xb8f36b, transparent: true, opacity: 0.55, depthWrite: false }),
  )
  splitExit.name = 'split-reversed-exit'
  splitField.add(splitExit)
  const splitAccent = new THREE.Group()
  splitAccent.name = 'split-stage-guidance'
  splitAccent.position.set(0, -SPLIT_S_TARGET_HEIGHT_M + 0.1, 0)
  const splitStageMaterial = new THREE.LineBasicMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.95, depthWrite: false })
  const splitStageReference = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-5, 0, 0), new THREE.Vector3(5, 0, 0),
      new THREE.Vector3(-5, -0.5, 0), new THREE.Vector3(-5, 0.5, 0),
      new THREE.Vector3(5, -0.5, 0), new THREE.Vector3(5, 0.5, 0),
      new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -2),
      new THREE.Vector3(-0.6, 0, -1), new THREE.Vector3(0, 0, -2),
      new THREE.Vector3(0.6, 0, -1), new THREE.Vector3(0, 0, -2),
    ]), splitStageMaterial,
  )
  splitStageReference.name = 'split-stage-reference'
  splitAccent.add(splitStageReference)
  splitField.add(splitAccent)
  scene.add(splitField)
  const splitReference: FlightSceneReference = {
    id: 'split-zone', kind: 'zone', object: splitField,
    positionM: { x: field.launch.x, y: config.ground.heightM + SPLIT_S_TARGET_HEIGHT_M, z: field.launch.z },
    sizeM: { x: SPLIT_S_AREA_RADIUS_M * 2, y: SPLIT_S_TARGET_HEIGHT_M - SPLIT_S_MIN_HEIGHT_M, z: SPLIT_S_AREA_RADIUS_M * 2 },
  }

  const orbitTarget = createOrbitTarget(field.launch, config.ground.heightM)
  const orbitField = new THREE.Group()
  orbitField.name = 'orbit-field'
  orbitField.position.set(orbitTarget.x, orbitTarget.y, orbitTarget.z)
  orbitField.visible = false
  // This broad, recognizable tower is an orientation reference, not a new
  // collision surface or a requirement to follow one exact-radius circle.
  const orbitTower = new THREE.Group()
  orbitTower.name = 'orbit-reference-tower'
  orbitTower.userData = { teachingReference: '正刷鍋參考塔', collision: false }
  const orbitTowerMaterial = material(0xd28bff, 0.65, 0.1)
  orbitTowerMaterial.emissive.set(0x57376b)
  orbitTowerMaterial.emissiveIntensity = 0.2
  const orbitColumn = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1, ORBIT_TARGET_HEIGHT_M + 2, 12), orbitTowerMaterial)
  orbitColumn.name = 'orbit-reference-column'
  orbitColumn.position.y = (ORBIT_TARGET_HEIGHT_M + 2) / 2 - ORBIT_TARGET_HEIGHT_M
  orbitTower.add(orbitColumn)
  const orbitFoot = new THREE.Mesh(new THREE.CylinderGeometry(2, 2.4, 0.3, 12), material(0x3a5560))
  orbitFoot.name = 'orbit-reference-foot'
  orbitFoot.position.y = -ORBIT_TARGET_HEIGHT_M + 0.15
  orbitTower.add(orbitFoot)
  for (const [index, height] of [4, 7, ORBIT_TARGET_HEIGHT_M, ORBIT_TARGET_HEIGHT_M + 2].entries()) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.25, 24), material(index === 2 ? 0xffc978 : 0x668691))
    band.name = `orbit-reference-band-${index}`
    band.position.y = height - ORBIT_TARGET_HEIGHT_M
    orbitTower.add(band)
  }
  orbitField.add(orbitTower)

  const orbitRouteMaterial = new THREE.LineDashedMaterial({ color: 0x8abac4, transparent: true, opacity: 0.5, dashSize: 0.85, gapSize: 0.6, depthWrite: false })
  const orbitRoute = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 128 }, (_, index) => {
    const angle = index / 128 * Math.PI * 2
    return new THREE.Vector3(Math.sin(angle) * ORBIT_TARGET_RADIUS_M, 0, Math.cos(angle) * ORBIT_TARGET_RADIUS_M)
  })), orbitRouteMaterial)
  orbitRoute.name = 'orbit-route-ring'
  orbitRoute.computeLineDistances()
  orbitField.add(orbitRoute)
  for (const [name, radius] of [['inner', ORBIT_MIN_RADIUS_M], ['outer', ORBIT_MAX_RADIUS_M]] as const) {
    const boundary = new THREE.Mesh(new THREE.RingGeometry(radius - 0.06, radius, 128),
      new THREE.MeshBasicMaterial({ color: 0xd28bff, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }))
    boundary.name = `orbit-ground-boundary-${name}`
    boundary.rotation.x = -Math.PI / 2
    boundary.position.y = -ORBIT_TARGET_HEIGHT_M + 0.025
    orbitField.add(boundary)
  }
  const orbitQuarterMarkers = new THREE.Group()
  orbitQuarterMarkers.name = 'orbit-quarter-markers'
  for (let index = 0; index < 4; index += 1) {
    const angle = index / 4 * Math.PI * 2
    const marker = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1.4, 0, 0), new THREE.Vector3(1.4, 0, 0),
      new THREE.Vector3(0, -1.4, 0), new THREE.Vector3(0, 1.4, 0),
    ]), new THREE.LineBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.6, depthWrite: false }))
    marker.name = `orbit-quarter-reference-${index}`
    marker.position.set(Math.sin(angle) * ORBIT_TARGET_RADIUS_M, 0, Math.cos(angle) * ORBIT_TARGET_RADIUS_M)
    marker.rotation.y = angle
    orbitQuarterMarkers.add(marker)
  }
  orbitField.add(orbitQuarterMarkers)
  const orbitEntry = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-3, -2, ORBIT_TARGET_RADIUS_M), new THREE.Vector3(3, -2, ORBIT_TARGET_RADIUS_M),
    new THREE.Vector3(3, 2, ORBIT_TARGET_RADIUS_M), new THREE.Vector3(-3, 2, ORBIT_TARGET_RADIUS_M),
  ]), new THREE.LineDashedMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.65, dashSize: 0.6, gapSize: 0.45, depthWrite: false }))
  orbitEntry.name = 'orbit-entry-band'
  orbitEntry.computeLineDistances()
  orbitField.add(orbitEntry)
  const orbitHeightGuide = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-ORBIT_TARGET_RADIUS_M - 4, -ORBIT_TARGET_HEIGHT_M, ORBIT_TARGET_RADIUS_M),
    new THREE.Vector3(-ORBIT_TARGET_RADIUS_M - 4, ORBIT_MAX_ENTRY_HEIGHT_M - ORBIT_TARGET_HEIGHT_M, ORBIT_TARGET_RADIUS_M),
    ...[ORBIT_MIN_ENTRY_HEIGHT_M, ORBIT_TARGET_HEIGHT_M, ORBIT_MAX_ENTRY_HEIGHT_M].flatMap((height) => [
      new THREE.Vector3(-ORBIT_TARGET_RADIUS_M - 4.5, height - ORBIT_TARGET_HEIGHT_M, ORBIT_TARGET_RADIUS_M),
      new THREE.Vector3(-ORBIT_TARGET_RADIUS_M - 3.5, height - ORBIT_TARGET_HEIGHT_M, ORBIT_TARGET_RADIUS_M),
    ]),
  ]), new THREE.LineBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.5, depthWrite: false }))
  orbitHeightGuide.name = 'orbit-height-guide'
  orbitField.add(orbitHeightGuide)
  const orbitAccent = new THREE.Group()
  orbitAccent.name = 'orbit-stage-guidance'
  orbitAccent.position.set(0, -ORBIT_TARGET_HEIGHT_M + 0.1, field.launch.z - orbitTarget.z)
  const orbitStageMaterial = new THREE.LineBasicMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.95, depthWrite: false })
  const orbitStageReference = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 32 }, (_, index) => {
    const angle = index / 32 * Math.PI * 2
    return new THREE.Vector3(Math.sin(angle) * 2.4, 0, Math.cos(angle) * 2.4)
  })), orbitStageMaterial)
  orbitStageReference.name = 'orbit-stage-reference'
  orbitAccent.add(orbitStageReference)
  orbitField.add(orbitAccent)
  const orbitExitPoints = [0, 1, 2, 3].flatMap((quadrant) => {
    const angle = quadrant / 4 * Math.PI * 2
    const radial = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle))
    const tangent = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle))
    const tip = radial.clone().multiplyScalar(ORBIT_TARGET_RADIUS_M + 8)
    const shoulder = radial.clone().multiplyScalar(ORBIT_TARGET_RADIUS_M + 6)
    return [radial.clone().multiplyScalar(ORBIT_TARGET_RADIUS_M + 2), tip,
      shoulder.clone().addScaledVector(tangent, -1.2), tip,
      shoulder.clone().addScaledVector(tangent, 1.2), tip]
  })
  const orbitExit = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(orbitExitPoints),
    new THREE.LineBasicMaterial({ color: 0xb8f36b, transparent: true, opacity: 0.8, depthWrite: false }))
  orbitExit.name = 'orbit-outward-exit-reference'
  orbitExit.visible = false
  orbitField.add(orbitExit)
  scene.add(orbitField)
  const orbitReference: FlightSceneReference = { id: 'orbit-zone', kind: 'zone', object: orbitField,
    positionM: { ...orbitTarget }, sizeM: { x: ORBIT_MAX_RADIUS_M * 2, y: ORBIT_MAX_ENTRY_HEIGHT_M - ORBIT_MIN_ENTRY_HEIGHT_M, z: ORBIT_MAX_RADIUS_M * 2 } }

  // The short broad corridor supplies landmarks in both viewing directions.
  // It is a visual reference: there are no new collision surfaces, narrow
  // gates, forced headings or hidden route checks.
  const backwardHeightM = BACKWARD_FLIGHT_TARGET_HEIGHT_M
  const backwardField = new THREE.Group()
  backwardField.name = 'backward-field'
  backwardField.position.set(field.launch.x, config.ground.heightM + backwardHeightM, field.launch.z - 25)
  backwardField.visible = false
  backwardField.userData = { teachingReference: '後退飛行寬走廊', collision: false }
  const backwardCorridor = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
    ...[-14, 14].flatMap((x) => [
      new THREE.Vector3(x, -backwardHeightM + 0.025, 39), new THREE.Vector3(x, -backwardHeightM + 0.025, -25),
      new THREE.Vector3(x, 0, 39), new THREE.Vector3(x, 0, -25),
    ]),
    ...[-15, 5, 25].flatMap((z) => [-14, 14].flatMap((x) => [
      new THREE.Vector3(x, -backwardHeightM, z), new THREE.Vector3(x, 10, z),
      new THREE.Vector3(x - 0.6, -6, z), new THREE.Vector3(x + 0.6, -6, z),
      new THREE.Vector3(x - 0.6, 0, z), new THREE.Vector3(x + 0.6, 0, z),
    ])),
  ]), new THREE.LineBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.4, depthWrite: false }))
  backwardCorridor.name = 'backward-broad-corridor'
  backwardField.add(backwardCorridor)
  for (const [name, count, z, color, label] of [
    ['arrival', 2, 35, 0x45d7f7, '來向：青色雙柱'],
    ['departure', 3, -15, 0xffc978, '去向：金色三柱'],
  ] as const) {
    const landmark = new THREE.Group()
    landmark.name = `backward-${name}-landmark`
    landmark.position.z = z
    landmark.userData = { teachingReference: label, collision: false }
    for (let index = 0; index < count; index += 1) {
      const column = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.7, 14, 8), material(color))
      column.name = `backward-${name}-column-${index}`
      column.position.set((index - (count - 1) / 2) * 5, 7 - backwardHeightM, 0)
      const cap = new THREE.Mesh(new THREE.ConeGeometry(1.1, 1.6, 4), material(color))
      cap.name = `backward-${name}-cap-${index}`
      cap.position.set(column.position.x, 14.8 - backwardHeightM, 0)
      landmark.add(column, cap)
    }
    backwardField.add(landmark)
  }
  const backwardTravelPoints = [-10, 2, 14, 26].flatMap((z) => [-backwardHeightM + 0.06, 0].flatMap((y) => [
    new THREE.Vector3(0, y, z + 3), new THREE.Vector3(0, y, z - 3),
    new THREE.Vector3(-1.1, y, z - 1.5), new THREE.Vector3(0, y, z - 3),
    new THREE.Vector3(1.1, y, z - 1.5), new THREE.Vector3(0, y, z - 3),
  ]))
  const backwardTravelGuide = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(backwardTravelPoints),
    new THREE.LineBasicMaterial({ color: 0xffc978, transparent: true, opacity: 0.5, depthWrite: false }))
  backwardTravelGuide.name = 'backward-original-travel-guide'
  backwardTravelGuide.userData = { teachingReference: '原移動方向：往金色三柱', collision: false }
  backwardField.add(backwardTravelGuide)
  const backwardAccent = new THREE.Group()
  backwardAccent.name = 'backward-stage-guidance'
  backwardAccent.position.set(0, -backwardHeightM + 0.1, 25)
  const backwardStageMaterial = new THREE.LineBasicMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.95, depthWrite: false })
  const backwardStageReference = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 40 }, (_, index) => {
    const angle = index / 40 * Math.PI * 2
    return new THREE.Vector3(Math.sin(angle) * 3, 0, Math.cos(angle) * 3)
  })), backwardStageMaterial)
  backwardStageReference.name = 'backward-stage-reference'
  backwardAccent.add(backwardStageReference)
  const backwardNoseArrow = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 2), new THREE.Vector3(0, 0, -2),
    new THREE.Vector3(-0.8, 0, -0.8), new THREE.Vector3(0, 0, -2),
    new THREE.Vector3(0.8, 0, -0.8), new THREE.Vector3(0, 0, -2),
  ]), new THREE.LineBasicMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.95, depthWrite: false }))
  backwardNoseArrow.name = 'backward-nose-direction-example'
  backwardNoseArrow.userData = { teachingReference: '機頭方向示意；不是即時飛行狀態', collision: false }
  backwardNoseArrow.position.x = -4
  const backwardMomentumArrow = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 2), new THREE.Vector3(0, 0, -2),
    new THREE.Vector3(-0.8, 0, -0.8), new THREE.Vector3(0, 0, -2),
    new THREE.Vector3(0.8, 0, -0.8), new THREE.Vector3(0, 0, -2),
  ]), new THREE.LineBasicMaterial({ color: 0xffc978, transparent: true, opacity: 0.95, depthWrite: false }))
  backwardMomentumArrow.name = 'backward-travel-direction-example'
  backwardMomentumArrow.userData = { teachingReference: '原移動方向示意；不是即時速度', collision: false }
  backwardMomentumArrow.position.x = 4
  backwardAccent.add(backwardNoseArrow, backwardMomentumArrow)
  backwardField.add(backwardAccent)
  scene.add(backwardField)
  const backwardReference: FlightSceneReference = { id: 'backward-zone', kind: 'zone', object: backwardField,
    positionM: { x: field.launch.x, y: config.ground.heightM + backwardHeightM, z: field.launch.z - 25 },
    sizeM: { x: 28, y: 20, z: 64 } }

  const reverseOrbitTarget = createReverseOrbitTarget(field.launch, config.ground.heightM)
  const reverseOrbitField = new THREE.Group()
  reverseOrbitField.name = 'reverse-orbit-field'
  reverseOrbitField.position.set(reverseOrbitTarget.x, reverseOrbitTarget.y, reverseOrbitTarget.z)
  reverseOrbitField.visible = false
  reverseOrbitField.add(createReverseOrbitCrane())
  const reverseFlightY = REVERSE_ORBIT_FLIGHT_HEIGHT_M - REVERSE_ORBIT_TARGET_HEIGHT_M
  const reverseRoute = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 128 }, (_, index) => {
    const angle = index / 128 * Math.PI * 2
    return new THREE.Vector3(Math.sin(angle) * REVERSE_ORBIT_TARGET_RADIUS_M, reverseFlightY,
      Math.cos(angle) * REVERSE_ORBIT_TARGET_RADIUS_M)
  })), new THREE.LineDashedMaterial({ color: 0x8abac4, transparent: true, opacity: 0.32, dashSize: 0.7, gapSize: 0.6, depthWrite: false }))
  reverseRoute.name = 'reverse-orbit-route-ring'
  reverseRoute.computeLineDistances()
  reverseOrbitField.add(reverseRoute)
  for (const [name, radius] of [['inner', REVERSE_ORBIT_MIN_RADIUS_M], ['outer', REVERSE_ORBIT_MAX_RADIUS_M]] as const) {
    const boundary = new THREE.Mesh(new THREE.RingGeometry(radius - 0.06, radius, 128),
      new THREE.MeshBasicMaterial({ color: 0xffc978, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false }))
    boundary.name = `reverse-orbit-ground-boundary-${name}`
    boundary.rotation.x = -Math.PI / 2
    boundary.position.y = -REVERSE_ORBIT_TARGET_HEIGHT_M + 0.025
    reverseOrbitField.add(boundary)
  }
  const reverseHeightGuide = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-REVERSE_ORBIT_TARGET_RADIUS_M - 4, -REVERSE_ORBIT_TARGET_HEIGHT_M, REVERSE_ORBIT_TARGET_RADIUS_M),
    new THREE.Vector3(-REVERSE_ORBIT_TARGET_RADIUS_M - 4, REVERSE_ORBIT_MAX_ENTRY_HEIGHT_M - REVERSE_ORBIT_TARGET_HEIGHT_M, REVERSE_ORBIT_TARGET_RADIUS_M),
    ...[REVERSE_ORBIT_MIN_ENTRY_HEIGHT_M, REVERSE_ORBIT_FLIGHT_HEIGHT_M, REVERSE_ORBIT_MAX_ENTRY_HEIGHT_M].flatMap((height) => [
      new THREE.Vector3(-REVERSE_ORBIT_TARGET_RADIUS_M - 4.5, height - REVERSE_ORBIT_TARGET_HEIGHT_M, REVERSE_ORBIT_TARGET_RADIUS_M),
      new THREE.Vector3(-REVERSE_ORBIT_TARGET_RADIUS_M - 3.5, height - REVERSE_ORBIT_TARGET_HEIGHT_M, REVERSE_ORBIT_TARGET_RADIUS_M),
    ]),
  ]), new THREE.LineBasicMaterial({ color: 0x8abac4, transparent: true, opacity: 0.45, depthWrite: false }))
  reverseHeightGuide.name = 'reverse-orbit-height-guide'
  reverseOrbitField.add(reverseHeightGuide)
  const reverseEntry = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-3, reverseFlightY - 2, REVERSE_ORBIT_TARGET_RADIUS_M), new THREE.Vector3(3, reverseFlightY - 2, REVERSE_ORBIT_TARGET_RADIUS_M),
    new THREE.Vector3(3, reverseFlightY + 2, REVERSE_ORBIT_TARGET_RADIUS_M), new THREE.Vector3(-3, reverseFlightY + 2, REVERSE_ORBIT_TARGET_RADIUS_M),
  ]), new THREE.LineDashedMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.55, dashSize: 0.6, gapSize: 0.45, depthWrite: false }))
  reverseEntry.name = 'reverse-orbit-entry-band'
  reverseEntry.computeLineDistances()
  reverseOrbitField.add(reverseEntry)
  const reverseAccent = new THREE.Group()
  reverseAccent.name = 'reverse-orbit-stage-guidance'
  reverseAccent.position.set(0, -REVERSE_ORBIT_TARGET_HEIGHT_M + 0.1, field.launch.z - reverseOrbitTarget.z)
  const reverseStageMaterial = new THREE.LineBasicMaterial({ color: 0x45d7f7, transparent: true, opacity: 0.95, depthWrite: false })
  const reverseStageReference = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 40 }, (_, index) => {
    const angle = index / 40 * Math.PI * 2
    return new THREE.Vector3(Math.sin(angle) * 2.6, 0, Math.cos(angle) * 2.6)
  })), reverseStageMaterial)
  reverseStageReference.name = 'reverse-orbit-stage-reference'
  reverseAccent.add(reverseStageReference)
  reverseOrbitField.add(reverseAccent)
  const reverseExit = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([0, 1, 2, 3].flatMap((quadrant) => {
    const angle = quadrant / 4 * Math.PI * 2
    const radial = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle))
    const tangent = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle))
    const tip = radial.clone().multiplyScalar(REVERSE_ORBIT_TARGET_RADIUS_M + 8)
    const shoulder = radial.clone().multiplyScalar(REVERSE_ORBIT_TARGET_RADIUS_M + 6)
    return [radial.clone().multiplyScalar(REVERSE_ORBIT_TARGET_RADIUS_M + 2), tip,
      shoulder.clone().addScaledVector(tangent, -1.2), tip, shoulder.clone().addScaledVector(tangent, 1.2), tip]
  }).map((point) => point.setY(reverseFlightY))), new THREE.LineBasicMaterial({ color: 0xb8f36b, transparent: true, opacity: 0.8, depthWrite: false }))
  reverseExit.name = 'reverse-orbit-outward-exit-reference'
  reverseExit.visible = false
  reverseOrbitField.add(reverseExit)
  scene.add(reverseOrbitField)
  const reverseOrbitReference: FlightSceneReference = { id: 'reverse-orbit-zone', kind: 'zone', object: reverseOrbitField,
    positionM: { ...reverseOrbitTarget }, sizeM: { x: REVERSE_ORBIT_MAX_RADIUS_M * 2,
      y: REVERSE_ORBIT_TARGET_HEIGHT_M, z: REVERSE_ORBIT_MAX_RADIUS_M * 2 } }

  const landingSurface: FlightSceneReference = { id: 'landing-surface', kind: 'zone', object: landingTarget, positionM: { ...field.landing }, sizeM: { x: LANDING_ZONE_RADIUS_M * 2, y: 0, z: LANDING_ZONE_RADIUS_M * 2 } }
  const launchReference: FlightSceneReference = { id: 'training-launch', kind: 'pad', object: takeoffPad, positionM: { ...field.launch } }
  const sceneReferences = [padReference, ...referenceSet.contract, landingSurface, launchReference, ...routeReferences, ...directionReferences, ...turnReferences, ...squareReferences, ...figureEightReferences, ...wideGateReferences, recoveryReference, rollReference, flipReference, loopReference, splitReference, orbitReference, backwardReference, reverseOrbitReference]
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
    loopField.visible = lessonId === 'power-loop'
    splitField.visible = lessonId === 'split-s'
    orbitField.visible = lessonId === 'orbit'
    backwardField.visible = lessonId === 'backward-flight'
    reverseOrbitField.visible = lessonId === 'reverse-orbit'
    const beginner = ['takeoff', 'landing', 'straight-line', 'direction-control', 'coordinated-turn', 'square-route', 'figure-eight', 'wide-gate', 'basic-recovery', 'full-roll', 'full-flip', 'front-flip', 'back-flip', 'power-loop', 'split-s', 'orbit', 'backward-flight', 'reverse-orbit'].includes(lessonId ?? '')
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

  const setPowerLoopStage = (stage: number | null): void => {
    if (stage === null || !Number.isInteger(stage) || stage < 0 || stage > 8) {
      loopAccent.visible = false
      return
    }
    loopAccent.visible = true
    loopStageMaterial.color.set(stage >= 7 ? 0xb8f36b : stage >= 3 ? 0xffc978 : 0x45d7f7)
    const [y, z] = stage <= 2 ? [0, -18]
      : stage === 3 ? [8, -26]
        : stage === 4 ? [16, -18]
          : stage === 5 ? [8, -10]
            : stage === 6 ? [0, -18] : [0, -24]
    loopAccent.position.set(0, y, z)
  }

  const setSplitSStage = (stage: number | null): void => {
    if (stage === null || !Number.isInteger(stage) || stage < 0 || stage > 8) {
      splitAccent.visible = false
      return
    }
    splitAccent.visible = true
    splitStageMaterial.color.set(stage >= 7 ? 0xb8f36b : stage >= 3 ? 0xffc978 : 0x45d7f7)
    const [y, z] = stage === 0 ? [-SPLIT_S_TARGET_HEIGHT_M + 0.1, 0]
      : stage <= 2 ? [0, splitBeamZ]
        : stage === 3 ? [0, splitPathZ]
          : stage === 4 ? [-splitPathRadiusM, splitPathZ - splitPathRadiusM]
            : stage === 5 ? [splitExitY, splitPathZ]
              : stage === 6 ? [splitExitY, splitBeamZ + 1] : [splitExitY, splitBeamZ + 8]
    splitAccent.position.set(0, y, z)
    splitAccent.rotation.y = stage >= 5 ? Math.PI : 0
  }

  const setOrbitStage = (stage: number | null): void => {
    if (stage === null || !Number.isInteger(stage) || stage < 0 || stage > 9) {
      orbitAccent.visible = false
      orbitExit.visible = false
      return
    }
    orbitAccent.visible = true
    orbitExit.visible = stage >= 8
    orbitStageMaterial.color.set(stage >= 9 ? 0xb8f36b : stage >= 3 ? 0xffc978 : 0x45d7f7)
    // The accent identifies the launch, entry or central subject. Cardinal
    // route markers stay neutral so left and right orbits are equally valid.
    orbitAccent.position.set(0, stage === 0 ? -ORBIT_TARGET_HEIGHT_M + 0.1 : 0,
      stage <= 1 ? field.launch.z - orbitTarget.z : stage === 2 ? ORBIT_TARGET_RADIUS_M : 0)
  }

  const setBackwardFlightStage = (stage: number | null): void => {
    if (stage === null || !Number.isInteger(stage) || stage < 0 || stage > 7) {
      backwardAccent.visible = false
      return
    }
    backwardAccent.visible = true
    backwardStageMaterial.color.set(stage >= 6 ? 0xb8f36b : stage >= 2 ? 0xffc978 : 0x45d7f7)
    backwardAccent.position.set(0, stage === 0 ? -backwardHeightM + 0.1 : 0, stage <= 1 ? 25 : 7)
    // The paired arrows explain the exercise, never follow or steer the drone.
    backwardNoseArrow.rotation.y = stage >= 3 ? Math.PI : 0
  }

  const setReverseOrbitStage = (stage: number | null): void => {
    if (stage === null || !Number.isInteger(stage) || stage < 0 || stage > 7) {
      reverseAccent.visible = false
      reverseExit.visible = false
      return
    }
    reverseAccent.visible = true
    reverseExit.visible = stage >= 6
    reverseStageMaterial.color.set(stage >= 7 ? 0xb8f36b : stage >= 3 ? 0xffc978 : 0x45d7f7)
    reverseAccent.position.set(0, stage === 0 ? -REVERSE_ORBIT_TARGET_HEIGHT_M + 0.1 : reverseFlightY,
      stage <= 1 ? field.launch.z - reverseOrbitTarget.z : stage === 2 ? REVERSE_ORBIT_TARGET_RADIUS_M : 0)
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
    setPowerLoopStage,
    setSplitSStage,
    setOrbitStage,
    setBackwardFlightStage,
    setReverseOrbitStage,
    setTrainingPath,
    setReplayPath,
    dispose: () => disposeFlightScene(scene),
  }
}
