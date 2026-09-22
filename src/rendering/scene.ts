import * as THREE from 'three'

import type { DroneConfig, DroneState } from '../drone'
import { DEFAULT_DRONE_CONFIG } from '../drone'
import type { Vector3 } from '../math/vector'

export type FlightSceneReferenceKind = 'pad' | 'marker' | 'gate'

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
  readonly ground: THREE.Mesh
  readonly grid: THREE.GridHelper
  readonly takeoffPad: THREE.Object3D
  /** Legacy visual collection; use sceneReferences for stable lesson IDs. */
  readonly references: readonly THREE.Object3D[]
  readonly sceneReferences: readonly FlightSceneReference[]
  getReference(id: string): FlightSceneReference | null
  applyState(state: DroneState): void
  dispose(): void
}

function material(color: number, roughness = 0.72, metalness = 0.05): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness })
}

function createQuadVisual(): THREE.Group {
  const quad = new THREE.Group()
  quad.name = 'quad'

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.09, 0.24),
    material(0x26343a, 0.5, 0.4),
  )
  body.name = 'quad-body'
  quad.add(body)

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.055, 0.16, 4),
    material(0xb8f36b, 0.55, 0.2),
  )
  nose.name = 'quad-nose'
  nose.rotation.x = -Math.PI / 2
  nose.position.set(0, 0.02, -0.17)
  quad.add(nose)

  const armMaterial = material(0x71909b, 0.58, 0.28)
  const motorMaterial = material(0x101820, 0.4, 0.65)
  const propMaterial = new THREE.MeshStandardMaterial({
    color: 0x91a4b0,
    transparent: true,
    opacity: 0.45,
    roughness: 0.7,
  })
  const motorPositions = [
    [-0.12, -0.12],
    [0.12, -0.12],
    [-0.12, 0.12],
    [0.12, 0.12],
  ] as const

  for (const [index, [x, z]] of motorPositions.entries()) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.045, 0.38), armMaterial)
    arm.name = `quad-arm-${index}`
    arm.position.set(x * 0.5, 0, z * 0.5)
    arm.rotation.y = index % 2 === 0 ? Math.atan2(x, z) : -Math.atan2(x, z)
    quad.add(arm)

    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.045, 12), motorMaterial)
    motor.name = `quad-motor-${index}`
    motor.position.set(x, 0.035, z)
    quad.add(motor)

    const prop = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.008, 0.018), propMaterial)
    prop.name = `quad-prop-${index}`
    prop.position.set(x, 0.065, z)
    prop.rotation.y = index % 2 === 0 ? Math.PI / 4 : -Math.PI / 4
    quad.add(prop)
  }

  return quad
}

function createReferenceObjects(): {
  readonly objects: readonly THREE.Object3D[]
  readonly contract: readonly FlightSceneReference[]
} {
  const references: THREE.Object3D[] = []
  const contract: FlightSceneReference[] = []
  const colors = [0xffc978, 0xb8f36b, 0x8abac4, 0xd28bff]
  const positions = [
    [-4, 0.45, -4],
    [4, 0.45, -4],
    [-4, 0.45, 4],
    [4, 0.45, 4],
  ] as const
  for (const [index, [x, y, z]] of positions.entries()) {
    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.18, 0.9, 6),
      material(colors[index], 0.65, 0.1),
    )
    marker.name = `reference-marker-${index}`
    marker.position.set(x, y, z)
    references.push(marker)
    contract.push({
      id: `marker-${index}`,
      kind: 'marker',
      object: marker,
      positionM: { x, y, z },
      sizeM: { x: 0.36, y: 0.9, z: 0.36 },
    })
  }

  const gate = new THREE.Group()
  gate.name = 'reference-gate'
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
    id: 'gate',
    kind: 'gate',
    object: gate,
    positionM: { x: 0, y: 0.9, z: -5 },
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
    new THREE.BoxGeometry(2.4, 0.08, 2.4),
    material(0x17262e, 0.78, 0.12),
  )
  padBase.position.y = config.ground.heightM + 0.04
  takeoffPad.add(padBase)
  const padLineMaterial = material(0xb8f36b, 0.58, 0.15)
  for (const [x, z, width, depth] of [
    [0, -1.04, 2.0, 0.035],
    [0, 1.04, 2.0, 0.035],
    [-1.04, 0, 0.035, 2.0],
    [1.04, 0, 0.035, 2.0],
  ] as const) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(width, 0.012, depth), padLineMaterial)
    line.position.set(x, config.ground.heightM + 0.087, z)
    takeoffPad.add(line)
  }
  takeoffPad.position.set(config.spawnPositionM.x, 0, config.spawnPositionM.z)
  scene.add(takeoffPad)

  const referenceSet = createReferenceObjects()
  for (const reference of referenceSet.objects) scene.add(reference)

  const padReference: FlightSceneReference = {
    id: 'takeoff-pad',
    kind: 'pad',
    object: takeoffPad,
    positionM: { ...config.spawnPositionM },
    sizeM: { x: 2.4, y: 0.08, z: 2.4 },
  }
  const sceneReferences = [padReference, ...referenceSet.contract]
  const referenceById = new Map(sceneReferences.map((reference) => [reference.id, reference]))

  const drone = createQuadVisual()
  scene.add(drone)

  const applyState = (state: DroneState): void => {
    drone.position.set(state.positionM.x, state.positionM.y, state.positionM.z)
    drone.quaternion.set(
      state.orientation.x,
      state.orientation.y,
      state.orientation.z,
      state.orientation.w,
    ).normalize()
  }

  return {
    scene,
    drone,
    ground,
    grid,
    takeoffPad,
    references: referenceSet.objects,
    sceneReferences,
    getReference: (id: string): FlightSceneReference | null => referenceById.get(id) ?? null,
    applyState,
    dispose: () => disposeFlightScene(scene),
  }
}