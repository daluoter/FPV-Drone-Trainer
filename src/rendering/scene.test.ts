import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

import { createDefaultDroneConfig, createInitialDroneState } from '../drone'
import { rotateVectorByQuaternion } from '../math/quaternion'
import { createCoordinatedTurnTargets, COORDINATED_TURN_TARGET_RADIUS_M } from '../training/coordinatedTurn'
import { createSquareRouteTargets, SQUARE_ROUTE_TARGET_RADIUS_M } from '../training/squareRoute'
import { createFigureEightTargets, FIGURE_EIGHT_TARGET_RADIUS_M } from '../training/figureEight'
import { createWideGates, WIDE_GATE_FRAME_DEPTH_M } from '../world/wideGates'
import { createGravityGate, gravityGateExitCrossing, gravityGateLowerCrossing, gravityGateTopCrossing } from '../world/gravityGate'
import { findSweptObstacleHit } from '../simulation/obstacles'
import { SPLIT_S_MIN_HEIGHT_M, SPLIT_S_TARGET_HEIGHT_M } from '../training/splitS'
import { POWER_LOOP_TARGET_HEIGHT_M } from '../training/powerLoop'
import { createOrbitTarget, ORBIT_TARGET_HEIGHT_M, ORBIT_TARGET_RADIUS_M, ORBIT_MAX_RADIUS_M } from '../training/orbit'
import { createTeachingDemonstration, teachingReverseOrbitPhaseAt } from '../training/demonstrations'
import { createReverseOrbitTarget, REVERSE_ORBIT_TARGET_HEIGHT_M, REVERSE_ORBIT_FLIGHT_HEIGHT_M, REVERSE_ORBIT_TARGET_RADIUS_M } from '../training/reverseOrbit'
import { createCameraRig, updateCameraRig } from './camera'
import { createTuningPreset } from '../tuning/presets'

import { createFlightScene } from './scene'

describe('flight scene reference contract', () => {
  it('shows the takeoff height guide instead of the separate hover target without changing evaluator anchors', () => {
    const scene = createFlightScene()
    try {
      const target = scene.scene.getObjectByName('takeoff-height-target')
      const hover = scene.getReference('hover-zone')
      const anchors = scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM: { ...positionM }, sizeM }))
      const dronePosition = scene.drone.position.toArray()
      expect(target).toBeDefined()
      expect(target?.position.toArray()).toEqual([0, 2.5, 0])
      expect(target?.visible).toBe(false)
      expect(hover?.object.visible).toBe(true)

      scene.setLessonTarget('takeoff')
      expect(target?.visible).toBe(true)
      expect(hover?.object.visible).toBe(false)
      expect(scene.scene.getObjectByName('takeoff-height-ring')).toBeDefined()
      expect(scene.scene.getObjectByName('takeoff-height-band')).toBeDefined()
      expect(scene.getReference('takeoff-height-target')).toBeNull()
      expect(scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM, sizeM }))).toEqual(anchors)
      expect(scene.drone.position.toArray()).toEqual(dronePosition)
      expect(scene.getReference('turn-entry')?.object.visible).toBe(false)
      expect(scene.getReference('orbit-poi')?.object.visible).toBe(false)

      scene.setLessonTarget('hover')
      expect(target?.visible).toBe(false)
      expect(hover?.object.visible).toBe(true)
      scene.setLessonTarget('takeoff')
      scene.setLessonTarget(null)
      expect(target?.visible).toBe(false)
      expect(hover?.object.visible).toBe(true)
    } finally {
      scene.dispose()
    }
  })

  it('positions the takeoff guide relative to a configured pad while leaving the config untouched', () => {
    const config = { ...createDefaultDroneConfig(), spawnPositionM: { x: 6, y: 1, z: -3 } }
    const scene = createFlightScene(config)
    try {
      scene.setLessonTarget('takeoff')
      expect(scene.scene.getObjectByName('takeoff-height-target')?.position.toArray()).toEqual([6, 3, -3])
      expect(scene.getReference('takeoff-pad')?.positionM).toEqual({ x: 6, y: 1, z: -3 })
      expect(config.spawnPositionM).toEqual({ x: 6, y: 1, z: -3 })
    } finally {
      scene.dispose()
    }
  })

  it('normalizes teaching spawn against raised ground and shifts visual and evaluator anchors together', () => {
    const defaults = createDefaultDroneConfig()
    const config = {
      ...defaults,
      ground: { ...defaults.ground, heightM: 5 },
      spawnPositionM: { x: 6, y: 0, z: -3 },
    }
    const initialSpawn = createInitialDroneState(config).positionM
    const scene = createFlightScene(config)
    try {
      expect(scene.getReference('takeoff-pad')?.positionM).toEqual(initialSpawn)
      expect(initialSpawn.y).toBeGreaterThan(5)
      expect(scene.scene.getObjectByName('takeoff-height-target')?.position.toArray()).toEqual([6, initialSpawn.y + 2, -3])
      expect(scene.scene.getObjectByName('straight-line-targets')?.children.map((ring) => ring.position.y))
        .toEqual([8, 8, 8, 8])
      expect(scene.getReference('hover-zone')?.positionM).toEqual({ x: 6, y: 8, z: -3 })
      expect(scene.getReference('hover-zone')?.object.position.y).toBe(8)
      for (const id of ['turn-entry', 'turn-apex', 'turn-exit']) {
        expect(scene.getReference(id)?.positionM.y).toBeCloseTo(5.45)
        expect(scene.getReference(id)?.object.position.y).toBeCloseTo(5.45)
      }
      expect(scene.getReference('orbit-poi')?.positionM.y).toBe(7.5)
      expect(scene.getReference('orbit-poi')?.object.position.y).toBe(7.5)
      const orbitCircle = scene.scene.getObjectByName('reference-orbit-circle')
      expect((orbitCircle?.parent?.position.y ?? 0) + (orbitCircle?.position.y ?? 0)).toBeCloseTo(5.02)
      expect(scene.getReference('split-s-reference')?.positionM.y).toBe(5.9)
      expect(scene.getReference('split-s-reference')?.object.position.y).toBe(5)
      expect(scene.getReference('landing-surface')?.positionM).toEqual({ x: 6, y: 5, z: -11 })
      expect(scene.getReference('training-launch')?.positionM).toEqual(createInitialDroneState(config, { x: 6, y: 5, z: -3 }).positionM)
      expect(scene.ground.position.y).toBe(5)
      expect(config.spawnPositionM).toEqual({ x: 6, y: 0, z: -3 })
      expect(config.ground.heightM).toBe(5)
    } finally {
      scene.dispose()
    }
  })

  it('shows only the selected beginner guide and restores advanced references on exit', () => {
    const scene = createFlightScene()
    const takeoff = scene.scene.getObjectByName('takeoff-height-target')
    const landing = scene.scene.getObjectByName('landing-target')
    const straight = scene.scene.getObjectByName('straight-line-targets')
    const anchors = scene.sceneReferences.map(({ id, positionM }) => ({ id, positionM: { ...positionM } }))
    try {
      scene.setLessonTarget('landing')
      expect(landing?.visible).toBe(true)
      expect(landing?.position.toArray()).toEqual([0, 0, -8])
      expect(landing?.getObjectByName('landing-beacon')).toBeDefined()
      expect(scene.getReference('training-launch')?.positionM.z).toBe(0)
      expect(takeoff?.visible).toBe(false)
      expect(straight?.visible).toBe(false)
      expect(scene.getReference('hover-zone')?.object.visible).toBe(false)
      expect(scene.getReference('split-s-reference')?.object.visible).toBe(false)

      scene.setLessonTarget('straight-line')
      expect(straight?.visible).toBe(true)
      expect(straight?.children).toHaveLength(4)
      expect(scene.getReference('straight-stop')?.positionM).toEqual({ x: 0, y: 3, z: -8 })
      expect(scene.getReference('straight-stop')?.sizeM).toEqual({ x: 3, y: 3, z: 0.08 })
      // The displayed opening must match the passage evaluator, including a
      // vertical green finish ring instead of the former horizontal stop disk.
      for (const id of ['straight-transit', 'straight-brake', 'straight-stop']) {
        const ring = scene.scene.getObjectByName(`${id}-ring`) as THREE.Mesh<THREE.RingGeometry>
        expect(ring.geometry.parameters.innerRadius).toBe(1.5)
        expect(ring.rotation.x).toBe(0)
        expect(ring.scale.toArray()).toEqual([1, 1, 1])
      }
      const landingPaint = landing?.getObjectByName('landing-zone-paint') as THREE.Mesh<THREE.RingGeometry>
      expect(landingPaint.geometry.parameters.outerRadius).toBe(1.5)
      expect(scene.getReference('landing-surface')?.sizeM).toEqual({ x: 3, y: 0, z: 3 })
      expect(landing?.visible).toBe(false)
      expect(takeoff?.visible).toBe(false)
      expect(scene.getReference('turn-entry')?.object.visible).toBe(false)
      expect(scene.getReference('orbit-poi')?.object.visible).toBe(false)

      scene.setLessonTarget('takeoff')
      expect(takeoff?.visible).toBe(true)
      expect(landing?.visible).toBe(false)
      expect(straight?.visible).toBe(false)

      scene.setLessonTarget(null)
      expect(takeoff?.visible).toBe(false)
      expect(landing?.visible).toBe(false)
      expect(straight?.visible).toBe(false)
      expect(scene.getReference('hover-zone')?.object.visible).toBe(true)
      expect(scene.getReference('turn-entry')?.object.visible).toBe(true)
      expect(scene.getReference('orbit-poi')?.object.visible).toBe(true)
      expect(scene.getReference('split-s-reference')?.object.visible).toBe(true)
      expect(scene.sceneReferences.map(({ id, positionM }) => ({ id, positionM }))).toEqual(anchors)
    } finally {
      scene.dispose()
    }
  })

  it('exposes stable lesson reference IDs without coupling evaluators to Three.js names', () => {
    const scene = createFlightScene()
    try {
      expect(scene.sceneReferences.map((reference) => reference.id)).toEqual([
        'takeoff-pad',
        'hover-zone',
        'turn-entry',
        'turn-apex',
        'turn-exit',
        'orbit-poi',
        'split-s-reference',
        'landing-surface',
        'training-launch',
        'straight-start',
        'straight-transit',
        'straight-brake',
        'straight-stop',
        'direction-right',
        'direction-left',
        'direction-forward',
        'direction-back',
        'direction-yaw',
        'direction-turned-forward',
        'direction-turned-right',
        'turn-right-entry',
        'turn-right-apex',
        'turn-right-exit',
        'turn-left-entry',
        'turn-left-apex',
        'turn-left-exit',
        'square-leg-1',
        'square-corner-1',
        'square-leg-2',
        'square-corner-2',
        'square-leg-3',
        'square-corner-3',
        'square-leg-4',
        'square-finish',
        'eight-entry',
        'eight-left-top',
        'eight-left-outer',
        'eight-left-bottom',
        'eight-crossing',
        'eight-right-top',
        'eight-right-outer',
        'eight-right-bottom',
        'eight-finish',
        'wide-gate-1',
        'wide-gate-2',
        'wide-gate-3',
        'recovery-zone',
        'roll-zone',
        'flip-zone',
        'loop-zone',
        'split-zone',
        'orbit-zone',
        'backward-zone',
        'reverse-orbit-zone',
        'gravity-gate-frame',
        'gravity-gate-top-entry',
        'gravity-gate-side-exit',
      ])
      expect(scene.getReference('hover-zone')?.kind).toBe('zone')
      expect(scene.getReference('hover-zone')?.positionM).toEqual({ x: 0, y: 3, z: 0 })
      expect(scene.getReference('orbit-poi')?.kind).toBe('poi')
      expect(scene.getReference('split-s-reference')?.kind).toBe('gate')
      expect(scene.getReference('split-s-reference')?.positionM).toEqual({ x: 0, y: 0.9, z: -5 })
      expect(scene.getReference('split-s-reference')?.sizeM).toEqual({ x: 5.12, y: 1.8, z: 0.12 })
      expect(scene.getReference('unknown')).toBeNull()
      scene.setTrainingPath([
        { x: 0, y: 1, z: 0 },
        { x: 1, y: 1, z: 0 },
      ])
      expect(scene.scene.getObjectByName('training-path')?.visible).toBe(true)
      scene.setTrainingPath([])
      expect(scene.scene.getObjectByName('training-path')?.visible).toBe(false)
      scene.applyGhost({
        positionM: { x: 2, y: 3, z: 4 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      })
      scene.setReplayPath([
        { x: 0, y: 1, z: 0 },
        { x: 2, y: 3, z: 4 },
      ])
      scene.setReplayVisible(true)
      expect(scene.ghost.position.toArray()).toEqual([2, 3, 4])
      expect(scene.ghost.visible).toBe(true)
      expect(scene.scene.getObjectByName('replay-path')?.visible).toBe(true)
      scene.setReplayVisible(false)
      expect(scene.ghost.visible).toBe(false)
      expect(scene.scene.getObjectByName('replay-path')?.visible).toBe(false)
    } finally {
      scene.dispose()
    }
  })

  it('selects one L05 goal at a time and keeps colocated movement and yaw steps distinct', () => {
    const scene = createFlightScene()
    const direction = scene.scene.getObjectByName('direction-control-targets')!
    const before = scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM: { ...positionM }, sizeM }))
    const droneBefore = scene.drone.position.toArray()
    const visibleGoals = () => direction.children.filter((marker) => marker.visible).map((marker) => marker.name)
    try {
      expect(direction.visible).toBe(false)
      scene.setLessonTarget('direction-control')
      expect(direction.visible).toBe(true)
      expect(scene.getReference('hover-zone')?.object.visible).toBe(false)
      expect(scene.scene.getObjectByName('landing-target')?.visible).toBe(false)
      expect(scene.scene.getObjectByName('straight-line-targets')?.visible).toBe(false)
      scene.setDirectionTarget('direction-left')
      expect(visibleGoals()).toEqual(['direction-left-zone'])
      scene.setDirectionTarget('direction-yaw')
      expect(visibleGoals()).toEqual(['direction-yaw-zone'])
      expect(scene.getReference('direction-left')?.positionM).toEqual(scene.getReference('direction-yaw')?.positionM)
      expect(scene.scene.getObjectByName('direction-yaw-turn-arc')).toBeDefined()
      const heading = scene.scene.getObjectByName('direction-yaw-heading')!
      // ArrowHelper's local +Y axis is the instructional heading direction.
      const headingDirection = rotateVectorByQuaternion(heading.quaternion, { x: 0, y: 1, z: 0 })
      expect(headingDirection.x).toBeCloseTo(1)
      expect(headingDirection.y).toBeCloseTo(0)
      expect(headingDirection.z).toBeCloseTo(0)
      scene.setDirectionTarget(null)
      expect(visibleGoals()).toEqual([])
      scene.setDirectionTarget('unknown')
      expect(visibleGoals()).toEqual([])
      scene.setDirectionTarget('direction-right')
      scene.setLessonTarget('hover')
      expect(direction.visible).toBe(false)
      expect(scene.getReference('hover-zone')?.object.visible).toBe(true)
      expect(scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM, sizeM }))).toEqual(before)
      expect(scene.drone.position.toArray()).toEqual(droneBefore)
    } finally {
      scene.dispose()
    }
  })

  it('uses ground-relative L05 spherical guides and a supported launch origin for elevated custom spawns', () => {
    const defaults = createDefaultDroneConfig()
    const config = { ...defaults, ground: { ...defaults.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 20, z: -3 } }
    const before = JSON.stringify(config)
    const scene = createFlightScene(config)
    try {
      expect(scene.getReference('direction-right')?.positionM).toEqual({ x: 10, y: 8, z: -3 })
      expect(scene.getReference('direction-forward')?.positionM).toEqual({ x: 2, y: 8, z: -7 })
      expect(scene.getReference('direction-turned-right')?.positionM).toEqual({ x: 6, y: 8, z: 1 })
      for (const reference of scene.sceneReferences.filter((candidate) => candidate.id.startsWith('direction-'))) {
        expect(reference.sizeM).toEqual({ x: 3, y: 3, z: 3 })
        expect(reference.object.position.toArray()).toEqual([reference.positionM.x, reference.positionM.y, reference.positionM.z])
        const ring = scene.scene.getObjectByName(`${reference.id}-outline-0`) as THREE.Mesh<THREE.RingGeometry>
        expect(ring.geometry.parameters.innerRadius).toBe(1.5)
        const paint = scene.scene.getObjectByName(`${reference.id}-ground-paint`)!
        expect(reference.object.position.y + paint.position.y).toBeCloseTo(5.018)
      }
      expect(JSON.stringify(config)).toBe(before)
    } finally {
      scene.dispose()
    }
  })

  it('shows one L06 target plus the faint route and hides the old turn prototype', () => {
    const scene = createFlightScene()
    const targets = scene.scene.getObjectByName('coordinated-turn-targets')!
    const route = scene.scene.getObjectByName('coordinated-turn-route')!
    const before = scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM: { ...positionM }, sizeM }))
    const droneBefore = scene.drone.position.toArray()
    const visibleGoals = () => targets.children.filter((marker) => marker.visible).map((marker) => marker.name)
    try {
      expect(targets.visible).toBe(false)
      expect(route.visible).toBe(false)
      scene.setLessonTarget('coordinated-turn')
      expect(targets.visible).toBe(true)
      expect(route.visible).toBe(true)
      expect(route.children.map((object) => object.name)).toEqual(['coordinated-turn-right-route', 'coordinated-turn-left-route'])
      expect(visibleGoals()).toEqual(['turn-right-entry-zone'])
      for (const id of ['hover-zone', 'turn-entry', 'turn-apex', 'turn-exit', 'orbit-poi', 'split-s-reference']) {
        expect(scene.getReference(id)?.object.visible).toBe(false)
      }
      expect(scene.scene.getObjectByName('direction-control-targets')?.visible).toBe(false)
      scene.setTurnTarget('turn-right-apex')
      expect(visibleGoals()).toEqual(['turn-right-apex-zone'])
      scene.setTurnTarget('turn-left-entry')
      expect(visibleGoals()).toEqual(['turn-left-entry-zone'])
      scene.setTurnTarget(null)
      expect(visibleGoals()).toEqual([])
      scene.setTurnTarget('unknown')
      expect(visibleGoals()).toEqual([])
      scene.setTurnTarget('turn-left-exit')
      scene.setLessonTarget('direction-control')
      expect(targets.visible).toBe(false)
      expect(route.visible).toBe(false)
      scene.setLessonTarget(null)
      expect(scene.getReference('turn-entry')?.object.visible).toBe(true)
      expect(scene.getReference('orbit-poi')?.object.visible).toBe(true)
      expect(scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM, sizeM }))).toEqual(before)
      expect(scene.drone.position.toArray()).toEqual(droneBefore)
    } finally {
      scene.dispose()
    }
  })

  it('shares L06 target positions, radii and headings with scoring on raised custom ground', () => {
    const defaults = createDefaultDroneConfig()
    const config = { ...defaults, ground: { ...defaults.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 20, z: -3 } }
    const before = JSON.stringify(config)
    const scene = createFlightScene(config)
    try {
      const launch = scene.getReference('training-launch')!.positionM
      for (const target of createCoordinatedTurnTargets(launch, config.ground.heightM)) {
        const reference = scene.getReference(target.id)!
        expect(reference.positionM).toEqual(target.positionM)
        expect(reference.object.position.toArray()).toEqual([target.positionM.x, target.positionM.y, target.positionM.z])
        const diameter = COORDINATED_TURN_TARGET_RADIUS_M * 2
        expect(reference.sizeM).toEqual({ x: diameter, y: diameter, z: diameter })
        const ring = scene.scene.getObjectByName(`${target.id}-outline-0`) as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
        expect(ring.geometry.parameters.innerRadius).toBe(COORDINATED_TURN_TARGET_RADIUS_M)
        expect(ring.material.color.getHex()).toBe(target.direction === 'right' ? 0xffc978 : 0x45d7f7)
        const paint = scene.scene.getObjectByName(`${target.id}-ground-paint`)!
        expect(reference.object.position.y + paint.position.y).toBeCloseTo(5.018)
        const arrow = scene.scene.getObjectByName(`${target.id}-heading`)!
        const heading = rotateVectorByQuaternion(arrow.quaternion, { x: 0, y: 1, z: 0 })
        expect(heading.x).toBeCloseTo(target.headingForward.x)
        expect(heading.y).toBeCloseTo(target.headingForward.y)
        expect(heading.z).toBeCloseTo(target.headingForward.z)
      }
      expect(scene.getReference('turn-right-entry')?.positionM).toEqual({ x: 6, y: 8, z: -9 })
      expect(scene.getReference('turn-left-exit')?.positionM).toEqual({ x: 22, y: 8, z: -21 })
      for (const name of ['coordinated-turn-right-route', 'coordinated-turn-left-route']) {
        const route = scene.scene.getObjectByName(name) as THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>
        const points = route.geometry.getAttribute('position')
        expect(points.count).toBe(65)
        for (let index = 0; index < points.count; index++) expect(points.getY(index)).toBeCloseTo(5.025)
        expect(route.material.opacity).toBeLessThan(0.5)
      }
      expect(JSON.stringify(config)).toBe(before)
    } finally {
      scene.dispose()
    }
  })

  it('disposes the L06 route and hidden arrival geometry with the scene', () => {
    const scene = createFlightScene()
    const ring = scene.scene.getObjectByName('turn-left-exit-outline-0') as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
    const route = scene.scene.getObjectByName('coordinated-turn-left-route') as THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>
    const ringGeometry = vi.spyOn(ring.geometry, 'dispose')
    const ringMaterial = vi.spyOn(ring.material, 'dispose')
    const routeGeometry = vi.spyOn(route.geometry, 'dispose')
    const routeMaterial = vi.spyOn(route.material, 'dispose')
    scene.dispose()
    expect(ringGeometry).toHaveBeenCalledOnce()
    expect(ringMaterial).toHaveBeenCalledOnce()
    expect(routeGeometry).toHaveBeenCalledOnce()
    expect(routeMaterial).toHaveBeenCalledOnce()
  })

  it('shows only the current L07 target and square outline while preserving other lesson guides', () => {
    const scene = createFlightScene()
    const targets = scene.scene.getObjectByName('square-route-targets')!
    const path = scene.scene.getObjectByName('square-route-path')!
    const anchors = scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM: { ...positionM }, sizeM }))
    const dronePosition = scene.drone.position.toArray()
    const visible = () => targets.children.filter((marker) => marker.visible).map((marker) => marker.name)
    try {
      expect(targets.visible).toBe(false)
      expect(path.visible).toBe(false)
      scene.setLessonTarget('square-route')
      expect(targets.visible).toBe(true)
      expect(path.visible).toBe(true)
      expect(targets.children).toHaveLength(8)
      expect(visible()).toEqual(['square-leg-1-zone'])
      for (const id of ['hover-zone', 'turn-entry', 'turn-apex', 'turn-exit', 'orbit-poi', 'split-s-reference']) {
        expect(scene.getReference(id)?.object.visible).toBe(false)
      }
      for (const name of ['direction-control-targets', 'coordinated-turn-targets', 'coordinated-turn-route', 'landing-target', 'straight-line-targets', 'takeoff-height-target']) {
        expect(scene.scene.getObjectByName(name)?.visible).toBe(false)
      }
      scene.setSquareTarget('square-corner-2')
      expect(visible()).toEqual(['square-corner-2-zone'])
      scene.setSquareTarget('square-finish')
      expect(visible()).toEqual(['square-finish-zone'])
      scene.setSquareTarget(null)
      expect(visible()).toEqual([])
      scene.setSquareTarget('unknown')
      expect(visible()).toEqual([])
      scene.setSquareTarget('square-leg-3')
      scene.setLessonTarget('coordinated-turn')
      expect(targets.visible).toBe(false)
      expect(path.visible).toBe(false)
      expect(scene.scene.getObjectByName('coordinated-turn-targets')?.visible).toBe(true)
      scene.setLessonTarget('direction-control')
      expect(scene.scene.getObjectByName('direction-control-targets')?.visible).toBe(true)
      expect(targets.visible).toBe(false)
      scene.setLessonTarget(null)
      expect(scene.getReference('turn-entry')?.object.visible).toBe(true)
      expect(scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM, sizeM }))).toEqual(anchors)
      expect(scene.drone.position.toArray()).toEqual(dronePosition)
    } finally {
      scene.dispose()
    }
  })

  it('shares L07 spherical geometry and headings above raised ground and closes the four-leg ground guide', () => {
    const defaults = createDefaultDroneConfig()
    const config = { ...defaults, ground: { ...defaults.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 20, z: -3 } }
    const before = JSON.stringify(config)
    const scene = createFlightScene(config)
    try {
      const launch = scene.getReference('training-launch')!.positionM
      for (const target of createSquareRouteTargets(launch, config.ground.heightM)) {
        const reference = scene.getReference(target.id)!
        expect(reference.positionM).toEqual(target.positionM)
        expect(reference.object.position.toArray()).toEqual([target.positionM.x, target.positionM.y, target.positionM.z])
        const diameter = SQUARE_ROUTE_TARGET_RADIUS_M * 2
        expect(reference.sizeM).toEqual({ x: diameter, y: diameter, z: diameter })
        const ring = scene.scene.getObjectByName(`${target.id}-outline-0`) as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
        expect(ring.geometry.parameters.innerRadius).toBe(SQUARE_ROUTE_TARGET_RADIUS_M)
        expect(ring.material.color.getHex()).toBe(target.kind === 'finish' ? 0xb8f36b : target.kind === 'corner' ? 0xffc978 : 0x45d7f7)
        const paint = scene.scene.getObjectByName(`${target.id}-ground-paint`)!
        expect(reference.object.position.y + paint.position.y).toBeCloseTo(5.018)
        const arrow = scene.scene.getObjectByName(`${target.id}-heading`)!
        const heading = rotateVectorByQuaternion(arrow.quaternion, { x: 0, y: 1, z: 0 })
        expect(heading.x).toBeCloseTo(target.headingForward.x)
        expect(heading.y).toBeCloseTo(target.headingForward.y)
        expect(heading.z).toBeCloseTo(target.headingForward.z)
      }
      expect(scene.getReference('square-leg-1')?.positionM).toEqual({ x: 6, y: 8, z: -9 })
      expect(scene.getReference('square-corner-2')?.positionM).toEqual({ x: 18, y: 8, z: -15 })
      expect(scene.getReference('square-finish')?.positionM).toEqual({ x: 6, y: 8, z: -3 })
      const route = scene.scene.getObjectByName('square-route-guide') as THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>
      const points = route.geometry.getAttribute('position')
      expect(points.count).toBe(5)
      const actual = Array.from({ length: points.count }, (_, index) => [points.getX(index), points.getZ(index)])
      expect(actual).toEqual([[6, -3], [6, -15], [18, -15], [18, -3], [6, -3]])
      for (let index = 0; index < points.count; index++) expect(points.getY(index)).toBeCloseTo(5.025)
      expect(route.material.opacity).toBeLessThan(0.5)
      expect(JSON.stringify(config)).toBe(before)
    } finally {
      scene.dispose()
    }
  })

  it('disposes the L07 path and hidden finish geometry with the scene', () => {
    const scene = createFlightScene()
    const ring = scene.scene.getObjectByName('square-finish-outline-0') as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
    const path = scene.scene.getObjectByName('square-route-guide') as THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>
    const ringGeometry = vi.spyOn(ring.geometry, 'dispose')
    const ringMaterial = vi.spyOn(ring.material, 'dispose')
    const pathGeometry = vi.spyOn(path.geometry, 'dispose')
    const pathMaterial = vi.spyOn(path.material, 'dispose')
    scene.dispose()
    expect(ringGeometry).toHaveBeenCalledOnce()
    expect(ringMaterial).toHaveBeenCalledOnce()
    expect(pathGeometry).toHaveBeenCalledOnce()
    expect(pathMaterial).toHaveBeenCalledOnce()
  })

  it('selects one L08 guide through the shared center and preserves existing lesson references', () => {
    const scene = createFlightScene()
    const targets = scene.scene.getObjectByName('figure-eight-targets')!
    const path = scene.scene.getObjectByName('figure-eight-path')!
    const anchors = scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM: { ...positionM }, sizeM }))
    const dronePosition = scene.drone.position.toArray()
    const visible = () => targets.children.filter((marker) => marker.visible).map((marker) => marker.name)
    try {
      expect(targets.visible).toBe(false)
      expect(path.visible).toBe(false)
      scene.setLessonTarget('figure-eight')
      expect(targets.visible).toBe(true)
      expect(path.visible).toBe(true)
      expect(targets.children).toHaveLength(9)
      expect(visible()).toEqual(['eight-entry-zone'])
      for (const id of ['hover-zone', 'turn-entry', 'turn-apex', 'turn-exit', 'orbit-poi', 'split-s-reference']) {
        expect(scene.getReference(id)?.object.visible).toBe(false)
      }
      for (const name of ['square-route-targets', 'square-route-path', 'direction-control-targets', 'coordinated-turn-targets', 'coordinated-turn-route', 'landing-target', 'straight-line-targets', 'takeoff-height-target']) {
        expect(scene.scene.getObjectByName(name)?.visible).toBe(false)
      }
      const centerObjects = ['eight-entry', 'eight-crossing', 'eight-finish'].map((id) => scene.getReference(id)!.object)
      expect(new Set(centerObjects).size).toBe(3)
      expect(centerObjects.map((marker) => marker.position.toArray())).toEqual([[0, 3, -6], [0, 3, -6], [0, 3, -6]])
      for (const id of ['eight-crossing', 'eight-right-top', 'eight-finish']) {
        scene.setFigureEightTarget(id)
        expect(visible()).toEqual([`${id}-zone`])
      }
      scene.setFigureEightTarget(null)
      expect(visible()).toEqual([])
      scene.setFigureEightTarget('unknown')
      expect(visible()).toEqual([])
      scene.setFigureEightTarget('eight-left-outer')
      scene.setLessonTarget('square-route')
      expect(targets.visible).toBe(false)
      expect(path.visible).toBe(false)
      expect(scene.scene.getObjectByName('square-route-targets')?.visible).toBe(true)
      scene.setLessonTarget('coordinated-turn')
      expect(scene.scene.getObjectByName('coordinated-turn-targets')?.visible).toBe(true)
      expect(targets.visible).toBe(false)
      scene.setLessonTarget(null)
      expect(scene.getReference('turn-entry')?.object.visible).toBe(true)
      expect(scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM, sizeM }))).toEqual(anchors)
      expect(scene.drone.position.toArray()).toEqual(dronePosition)
    } finally {
      scene.dispose()
    }
  })

  it('shares L08 spherical geometry on raised ground and closes both loop guides at their shared center', () => {
    const defaults = createDefaultDroneConfig()
    const config = { ...defaults, ground: { ...defaults.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 20, z: -3 } }
    const before = JSON.stringify(config)
    const scene = createFlightScene(config)
    try {
      const launch = scene.getReference('training-launch')!.positionM
      const layout = createFigureEightTargets(launch, config.ground.heightM)
      for (const target of layout) {
        const reference = scene.getReference(target.id)!
        expect(reference.positionM).toEqual(target.positionM)
        expect(reference.object.position.toArray()).toEqual([target.positionM.x, target.positionM.y, target.positionM.z])
        const diameter = FIGURE_EIGHT_TARGET_RADIUS_M * 2
        expect(reference.sizeM).toEqual({ x: diameter, y: diameter, z: diameter })
        const ring = scene.scene.getObjectByName(`${target.id}-outline-0`) as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
        expect(ring.geometry.parameters.innerRadius).toBe(FIGURE_EIGHT_TARGET_RADIUS_M)
        expect(ring.material.color.getHex()).toBe(target.kind === 'finish' ? 0xb8f36b : target.kind === 'crossing' ? 0xd28bff
          : target.kind === 'entry' ? 0x8abac4 : target.loop === 1 ? 0xffc978 : 0x45d7f7)
        const paint = scene.scene.getObjectByName(`${target.id}-ground-paint`)!
        expect(reference.object.position.y + paint.position.y).toBeCloseTo(5.018)
        const arrow = scene.scene.getObjectByName(`${target.id}-heading`)!
        const heading = rotateVectorByQuaternion(arrow.quaternion, { x: 0, y: 1, z: 0 })
        expect(heading.x).toBeCloseTo(target.headingForward.x)
        expect(heading.y).toBeCloseTo(target.headingForward.y)
        expect(heading.z).toBeCloseTo(target.headingForward.z)
      }
      expect(scene.getReference('eight-entry')?.positionM).toEqual({ x: 6, y: 8, z: -9 })
      expect(scene.getReference('eight-left-outer')?.positionM).toEqual({ x: -6, y: 8, z: -9 })
      expect(scene.getReference('eight-right-outer')?.positionM).toEqual({ x: 18, y: 8, z: -9 })
      expect(scene.getReference('eight-finish')?.positionM).toEqual(scene.getReference('eight-crossing')?.positionM)
      for (const [loopIndex, loopTargets] of [layout.slice(0, 5), layout.slice(4)].entries()) {
        const route = scene.scene.getObjectByName(`figure-eight-${loopIndex === 0 ? 'left' : 'right'}-guide`) as THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>
        const points = route.geometry.getAttribute('position')
        expect(points.count).toBe(65)
        expect(route.material.color.getHex()).toBe(loopIndex === 0 ? 0xffc978 : 0x45d7f7)
        expect(route.material.opacity).toBeLessThan(0.5)
        for (let index = 0; index < points.count; index++) expect(points.getY(index)).toBeCloseTo(5.025)
        for (const [index, target] of loopTargets.entries()) {
          expect(points.getX(index * 16)).toBeCloseTo(target.positionM.x)
          expect(points.getZ(index * 16)).toBeCloseTo(target.positionM.z)
        }
        expect(points.getX(0)).toBeCloseTo(points.getX(64))
        expect(points.getZ(0)).toBeCloseTo(points.getZ(64))
      }
      expect(JSON.stringify(config)).toBe(before)
    } finally {
      scene.dispose()
    }
  })

  it('disposes both L08 ground loops and hidden finish geometry with the scene', () => {
    const scene = createFlightScene()
    const ring = scene.scene.getObjectByName('eight-finish-outline-0') as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
    const left = scene.scene.getObjectByName('figure-eight-left-guide') as THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>
    const right = scene.scene.getObjectByName('figure-eight-right-guide') as THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>
    const dispose = [ring.geometry, ring.material, left.geometry, left.material, right.geometry, right.material].map((value) => vi.spyOn(value, 'dispose'))
    scene.dispose()
    for (const spy of dispose) expect(spy).toHaveBeenCalledOnce()
  })

  it('keeps every L09 physical frame visible while selecting only the current guidance', () => {
    const scene = createFlightScene()
    const field = scene.scene.getObjectByName('wide-gate-field')!
    const anchors = scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM: { ...positionM }, sizeM }))
    const dronePosition = scene.drone.position.toArray()
    const visibleGuides = () => field.children.flatMap((frame) => frame.children.filter((child) => child.name.endsWith('-guidance') && child.visible).map((child) => child.name))
    const assertFramesRemain = () => {
      expect(field.children).toHaveLength(3)
      for (const frame of field.children) {
        expect(frame.visible).toBe(true)
        const boxes = frame.children.filter((child) => !child.name.endsWith('-guidance'))
        expect(boxes).toHaveLength(4)
        expect(boxes.every((box) => box.visible)).toBe(true)
      }
    }
    try {
      expect(field.visible).toBe(false)
      scene.setLessonTarget('wide-gate')
      expect(field.visible).toBe(true)
      assertFramesRemain()
      expect(visibleGuides()).toEqual(['wide-gate-1-guidance'])
      for (const id of ['hover-zone', 'turn-entry', 'turn-apex', 'turn-exit', 'orbit-poi', 'split-s-reference']) {
        expect(scene.getReference(id)?.object.visible).toBe(false)
      }
      for (const name of ['figure-eight-targets', 'figure-eight-path', 'square-route-targets', 'square-route-path', 'direction-control-targets', 'coordinated-turn-targets', 'coordinated-turn-route', 'landing-target', 'straight-line-targets', 'takeoff-height-target']) {
        expect(scene.scene.getObjectByName(name)?.visible).toBe(false)
      }
      for (const id of ['wide-gate-2', 'wide-gate-3']) {
        scene.setWideGateTarget(id)
        expect(visibleGuides()).toEqual([`${id}-guidance`])
        assertFramesRemain()
      }
      for (const id of [null, 'unknown']) {
        scene.setWideGateTarget(id)
        expect(visibleGuides()).toEqual([])
        assertFramesRemain()
      }
      scene.setLessonTarget('figure-eight')
      expect(field.visible).toBe(false)
      expect(scene.scene.getObjectByName('figure-eight-targets')?.visible).toBe(true)
      scene.setLessonTarget(null)
      expect(field.visible).toBe(false)
      expect(scene.getReference('turn-entry')?.object.visible).toBe(true)
      expect(scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM, sizeM }))).toEqual(anchors)
      expect(scene.drone.position.toArray()).toEqual(dronePosition)
    } finally {
      scene.dispose()
    }
  })

  it('draws the exact shared L09 collision boxes and leaves each four-meter opening clear on raised ground', () => {
    const defaults = createDefaultDroneConfig()
    const config = { ...defaults, ground: { ...defaults.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 20, z: -3 } }
    const before = JSON.stringify(config)
    const scene = createFlightScene(config)
    try {
      const launch = scene.getReference('training-launch')!.positionM
      for (const [index, gate] of createWideGates(launch, config.ground.heightM).entries()) {
        const reference = scene.getReference(gate.id)!
        expect(reference.kind).toBe('gate')
        expect(reference.positionM).toEqual(gate.positionM)
        expect(reference.object.position.toArray()).toEqual([gate.positionM.x, gate.positionM.y, gate.positionM.z])
        expect(reference.sizeM).toEqual({ x: 4, y: 4, z: WIDE_GATE_FRAME_DEPTH_M })
        for (const collider of gate.colliders) {
          const box = scene.scene.getObjectByName(collider.id) as THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>
          const center = box.getWorldPosition(box.position.clone())
          expect(center.x).toBeCloseTo(collider.centerM.x)
          expect(center.y).toBeCloseTo(collider.centerM.y)
          expect(center.z).toBeCloseTo(collider.centerM.z)
          const { width, height, depth } = box.geometry.parameters
          expect(width).toBe(collider.halfExtentsM.x * 2)
          expect(height).toBe(collider.halfExtentsM.y * 2)
          expect(depth).toBe(collider.halfExtentsM.z * 2)
          expect(box.material.color.getHex()).toBe([0x45d7f7, 0xffc978, 0xb8f36b][index])
          expect(box.material.transparent).toBe(false)
          const overlapX = Math.min(center.x + width / 2, gate.positionM.x + 2) - Math.max(center.x - width / 2, gate.positionM.x - 2)
          const overlapY = Math.min(center.y + height / 2, gate.positionM.y + 2) - Math.max(center.y - height / 2, gate.positionM.y - 2)
          expect(Math.min(overlapX, overlapY)).toBeLessThanOrEqual(1e-10)
          if (collider.id.endsWith('-post')) expect(center.y - height / 2).toBeCloseTo(config.ground.heightM)
        }
        const opening = scene.scene.getObjectByName(`${gate.id}-opening-guide`) as THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>
        const points = opening.geometry.getAttribute('position')
        expect(points.count).toBe(4)
        expect(Array.from({ length: points.count }, (_, index) => [points.getX(index), points.getY(index)])).toEqual([[-2, -2], [2, -2], [2, 2], [-2, 2]])
        expect(opening.material.color.getHex()).toBe(0xffffff)
        const arrow = scene.scene.getObjectByName(`${gate.id}-heading`)!
        const heading = rotateVectorByQuaternion(arrow.quaternion, { x: 0, y: 1, z: 0 })
        expect(heading.x).toBeCloseTo(0)
        expect(heading.y).toBeCloseTo(0)
        expect(heading.z).toBeCloseTo(-1)
      }
      expect(scene.getReference('wide-gate-1')?.positionM).toEqual({ x: 6, y: 8, z: -11 })
      expect(scene.getReference('wide-gate-3')?.positionM).toEqual({ x: 6, y: 8, z: -27 })
      expect(JSON.stringify(config)).toBe(before)
    } finally {
      scene.dispose()
    }
  })

  it('disposes physical L09 boxes and hidden guidance with the scene', () => {
    const scene = createFlightScene()
    const frame = scene.scene.getObjectByName('wide-gate-1-left-post') as THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>
    const guidance = scene.scene.getObjectByName('wide-gate-3-opening-guide') as THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>
    const dispose = [frame.geometry, frame.material, guidance.geometry, guidance.material].map((value) => vi.spyOn(value, 'dispose'))
    scene.dispose()
    for (const spy of dispose) expect(spy).toHaveBeenCalledOnce()
  })

  it('shows the L10 practice area without previous course frames and colors only its stage guidance', () => {
    const scene = createFlightScene()
    const area = scene.scene.getObjectByName('basic-recovery-field')!
    const accent = scene.scene.getObjectByName('recovery-stage-guidance')!
    const level = scene.scene.getObjectByName('recovery-level-reference') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
    const anchors = scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM: { ...positionM }, sizeM }))
    const dronePosition = scene.drone.position.toArray()
    try {
      expect(area.visible).toBe(false)
      scene.setLessonTarget('basic-recovery')
      expect(area.visible).toBe(true)
      for (const name of ['wide-gate-field', 'figure-eight-targets', 'figure-eight-path', 'square-route-targets', 'coordinated-turn-targets', 'straight-line-targets', 'landing-target']) {
        expect(scene.scene.getObjectByName(name)?.visible).toBe(false)
      }
      for (const id of ['hover-zone', 'orbit-poi', 'split-s-reference']) expect(scene.getReference(id)?.object.visible).toBe(false)
      for (const stage of [0, 1, 2, 4, 6]) {
        scene.setRecoveryStage(stage)
        expect(accent.visible).toBe(true)
        expect(level.material.color.getHex()).toBe(0x45d7f7)
      }
      for (const stage of [3, 5, 7]) {
        scene.setRecoveryStage(stage)
        expect(level.material.color.getHex()).toBe(0xffc978)
      }
      scene.setRecoveryStage(8)
      expect(level.material.color.getHex()).toBe(0xb8f36b)
      for (const stage of [null, -1, 9, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        scene.setRecoveryStage(stage)
        expect(accent.visible).toBe(false)
        expect(area.visible).toBe(true)
        expect(scene.scene.getObjectByName('recovery-area-boundary')?.visible).toBe(true)
        expect(scene.scene.getObjectByName('recovery-height-band')?.visible).toBe(true)
      }
      scene.setLessonTarget('wide-gate')
      expect(area.visible).toBe(false)
      expect(scene.scene.getObjectByName('wide-gate-field')?.visible).toBe(true)
      scene.setLessonTarget(null)
      expect(area.visible).toBe(false)
      expect(scene.scene.getObjectByName('wide-gate-field')?.visible).toBe(false)
      expect(scene.getReference('hover-zone')?.object.visible).toBe(true)
      expect(scene.drone.position.toArray()).toEqual(dronePosition)
      expect(scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM, sizeM }))).toEqual(anchors)
    } finally {
      scene.dispose()
    }
  })

  it('anchors the broad L10 floor, height band and horizontal reference to ground rather than a high configured spawn', () => {
    const defaults = createDefaultDroneConfig()
    const config = { ...defaults, ground: { ...defaults.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 30, z: -3 } }
    const before = JSON.stringify(config)
    const scene = createFlightScene(config)
    try {
      const reference = scene.getReference('recovery-zone')!
      expect(reference.kind).toBe('zone')
      expect(reference.positionM).toEqual({ x: 6, y: 9, z: -3 })
      expect(reference.object.position.toArray()).toEqual([6, 9, -3])
      expect(reference.sizeM).toEqual({ x: 80, y: 5, z: 80 })
      const floor = scene.scene.getObjectByName('recovery-area-boundary') as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
      expect(floor.geometry.parameters.innerRadius).toBeCloseTo(39.93)
      expect(floor.geometry.parameters.outerRadius).toBe(40)
      expect(floor.rotation.x).toBe(-Math.PI / 2)
      expect(floor.getWorldPosition(floor.position.clone()).y).toBeCloseTo(5.025)
      expect(floor.material.transparent).toBe(true)
      const band = scene.scene.getObjectByName('recovery-height-band') as THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>
      const points = band.geometry.getAttribute('position')
      expect(Array.from({ length: points.count }, (_, index) => points.getY(index) + reference.positionM.y)).toEqual([8, 8, 13, 13])
      expect(band.material.opacity).toBeLessThan(0.5)
      const level = scene.scene.getObjectByName('recovery-level-reference') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
      const levelPoints = level.geometry.getAttribute('position')
      // The long reference is truly horizontal in world space, centered at 4 m AGL.
      expect(levelPoints.getY(0) + reference.positionM.y).toBe(9)
      expect(levelPoints.getY(1) + reference.positionM.y).toBe(9)
      expect(levelPoints.getX(0) + reference.positionM.x).toBe(1)
      expect(levelPoints.getX(1) + reference.positionM.x).toBe(11)
      expect(levelPoints.getZ(0) + reference.positionM.z).toBe(-15)
      const pole = scene.scene.getObjectByName('recovery-height-pole') as THREE.LineSegments<THREE.BufferGeometry>
      expect(pole.geometry.getAttribute('position').getX(0)).toBe(8)
      expect(pole.geometry.getAttribute('position').getZ(0)).toBe(-10)
      expect(reference.object.children.filter((child) => (child as THREE.Mesh).isMesh)).toEqual([floor])
      expect(JSON.stringify(config)).toBe(before)
    } finally {
      scene.dispose()
    }
  })

  it('disposes the hidden L10 floor and each visual line without leaving resources behind', () => {
    const scene = createFlightScene()
    const resources = ['recovery-area-boundary', 'recovery-height-pole', 'recovery-height-band', 'recovery-level-reference'].flatMap((name) => {
      const object = scene.scene.getObjectByName(name) as THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
      return [object.geometry, object.material]
    })
    const dispose = resources.map((resource) => vi.spyOn(resource, 'dispose'))
    scene.dispose()
    for (const spy of dispose) expect(spy).toHaveBeenCalledOnce()
  })

  it('shows only the full-roll field and colors its world-upright reference without moving flight objects or anchors', () => {
    const scene = createFlightScene()
    const field = scene.scene.getObjectByName('full-roll-field')!
    const accent = scene.scene.getObjectByName('roll-stage-guidance')!
    const level = scene.scene.getObjectByName('roll-level-reference') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
    const up = scene.scene.getObjectByName('roll-world-up-reference') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
    const before = scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM: { ...positionM }, sizeM }))
    const drone = scene.drone.position.toArray()
    const ghost = scene.ghost.position.toArray()
    try {
      expect(field.visible).toBe(false)
      scene.setLessonTarget('full-roll')
      expect(field.visible).toBe(true)
      for (const name of ['basic-recovery-field', 'wide-gate-field', 'figure-eight-targets', 'square-route-targets', 'coordinated-turn-targets', 'straight-line-targets', 'landing-target', 'takeoff-height-target']) {
        expect(scene.scene.getObjectByName(name)?.visible).toBe(false)
      }
      for (const id of ['hover-zone', 'orbit-poi', 'split-s-reference']) expect(scene.getReference(id)?.object.visible).toBe(false)
      for (const [stage, color] of [[0, 0x45d7f7], [2, 0x45d7f7], [3, 0xffc978], [4, 0xffc978], [5, 0xb8f36b], [6, 0xb8f36b]]) {
        scene.setFullRollStage(stage)
        expect(accent.visible).toBe(true)
        expect(level.material.color.getHex()).toBe(color)
        expect(up.material.color.getHex()).toBe(color)
      }
      for (const stage of [null, -1, 7, 1.5, Number.NaN]) {
        scene.setFullRollStage(stage)
        expect(accent.visible).toBe(false)
        expect(field.visible).toBe(true)
        expect(scene.scene.getObjectByName('roll-height-band')?.visible).toBe(true)
      }
      expect(scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM, sizeM }))).toEqual(before)
      expect(scene.drone.position.toArray()).toEqual(drone)
      expect(scene.ghost.position.toArray()).toEqual(ghost)
      scene.setLessonTarget('basic-recovery')
      expect(field.visible).toBe(false)
      expect(scene.scene.getObjectByName('basic-recovery-field')?.visible).toBe(true)
      scene.setLessonTarget(null)
      expect(field.visible).toBe(false)
      expect(scene.getReference('hover-zone')?.object.visible).toBe(true)
    } finally {
      scene.dispose()
    }
  })

  it('anchors full-roll height and ground guides to raised ground rather than a configured airborne spawn', () => {
    const defaults = createDefaultDroneConfig()
    const config = { ...defaults, ground: { ...defaults.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 30, z: -3 } }
    const original = JSON.stringify(config)
    const scene = createFlightScene(config)
    try {
      const reference = scene.getReference('roll-zone')!
      expect(scene.sceneReferences.at(-10)?.id).toBe('roll-zone')
      expect(reference.kind).toBe('zone')
      expect(reference.positionM).toEqual({ x: 6, y: 15, z: -3 })
      expect(reference.object.position.toArray()).toEqual([6, 15, -3])
      expect(reference.sizeM).toEqual({ x: 120, y: 6, z: 120 })
      const floor = scene.scene.getObjectByName('roll-area-boundary') as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
      expect(floor.geometry.parameters.innerRadius).toBeCloseTo(59.93)
      expect(floor.geometry.parameters.outerRadius).toBe(60)
      expect(floor.getWorldPosition(floor.position.clone()).y).toBeCloseTo(5.025)
      const meshes: THREE.Object3D[] = []
      reference.object.traverse((object) => { if ((object as THREE.Mesh).isMesh) meshes.push(object) })
      expect(meshes).toEqual([floor])
      expect(floor.material.transparent).toBe(true)
      const band = scene.scene.getObjectByName('roll-height-band') as THREE.LineLoop<THREE.BufferGeometry>
      const bandPoints = band.geometry.getAttribute('position')
      expect(Array.from({ length: bandPoints.count }, (_, i) => bandPoints.getY(i) + reference.positionM.y)).toEqual([13, 13, 19, 19])
      const level = scene.scene.getObjectByName('roll-level-reference') as THREE.LineSegments<THREE.BufferGeometry>
      const levelPoints = level.geometry.getAttribute('position')
      expect(levelPoints.getY(0) + reference.positionM.y).toBe(15)
      expect(levelPoints.getY(1) + reference.positionM.y).toBe(15)
      expect(levelPoints.getX(0) + reference.positionM.x).toBe(-2)
      expect(levelPoints.getX(1) + reference.positionM.x).toBe(14)
      const up = scene.scene.getObjectByName('roll-world-up-reference') as THREE.LineSegments<THREE.BufferGeometry>
      expect(up.geometry.getAttribute('position').getY(1) + reference.positionM.y).toBe(17)
      const worldDirection = rotateVectorByQuaternion(level.getWorldQuaternion(level.quaternion.clone()), { x: 1, y: 0, z: 0 })
      scene.applyState({ ...createInitialDroneState(config), orientation: { x: 0, y: 0, z: -1, w: 0 } })
      expect(rotateVectorByQuaternion(level.getWorldQuaternion(level.quaternion.clone()), { x: 1, y: 0, z: 0 })).toEqual(worldDirection)
      expect(JSON.stringify(config)).toBe(original)
    } finally {
      scene.dispose()
    }
  })

  it('disposes every full-roll guide including its hidden world-up marker', () => {
    const scene = createFlightScene()
    const resources = ['roll-area-boundary', 'roll-height-pole', 'roll-height-band', 'roll-level-reference', 'roll-world-up-reference'].flatMap((name) => {
      const object = scene.scene.getObjectByName(name) as THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
      return [object.geometry, object.material]
    })
    const dispose = resources.map((resource) => vi.spyOn(resource, 'dispose'))
    scene.dispose()
    for (const spy of dispose) expect(spy).toHaveBeenCalledOnce()
  })

  it('shows only the full-flip field and colors its world-upright reference without moving flight objects or anchors', () => {
    const scene = createFlightScene()
    const field = scene.scene.getObjectByName('full-flip-field')!
    const accent = scene.scene.getObjectByName('flip-stage-guidance')!
    const level = scene.scene.getObjectByName('flip-level-reference') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
    const up = scene.scene.getObjectByName('flip-world-up-reference') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
    const directions = ['flip-forward-reference', 'flip-backward-reference'].map((name) => scene.scene.getObjectByName(name) as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>)
    const before = scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM: { ...positionM }, sizeM }))
    const drone = scene.drone.position.toArray()
    const ghost = scene.ghost.position.toArray()
    try {
      expect(field.visible).toBe(false)
      scene.setLessonTarget('full-flip')
      expect(field.visible).toBe(true)
      for (const name of ['full-roll-field', 'basic-recovery-field', 'wide-gate-field', 'figure-eight-targets', 'square-route-targets', 'coordinated-turn-targets', 'straight-line-targets', 'landing-target', 'takeoff-height-target']) {
        expect(scene.scene.getObjectByName(name)?.visible).toBe(false)
      }
      for (const id of ['hover-zone', 'orbit-poi', 'split-s-reference']) expect(scene.getReference(id)?.object.visible).toBe(false)
      for (const [stage, color] of [[0, 0x45d7f7], [2, 0x45d7f7], [3, 0xffc978], [4, 0xffc978], [5, 0xb8f36b], [6, 0xb8f36b]]) {
        scene.setFullFlipStage(stage)
        expect(accent.visible).toBe(true)
        expect(level.material.color.getHex()).toBe(color)
        expect(up.material.color.getHex()).toBe(color)
        for (const direction of directions) expect(direction.material.color.getHex()).toBe(color)
      }
      for (const stage of [null, -1, 7, 1.5, Number.NaN]) {
        scene.setFullFlipStage(stage)
        expect(accent.visible).toBe(false)
        expect(field.visible).toBe(true)
        expect(scene.scene.getObjectByName('flip-height-band')?.visible).toBe(true)
      }
      expect(scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM, sizeM }))).toEqual(before)
      expect(scene.drone.position.toArray()).toEqual(drone)
      expect(scene.ghost.position.toArray()).toEqual(ghost)
      scene.setLessonTarget('basic-recovery')
      expect(field.visible).toBe(false)
      expect(scene.scene.getObjectByName('basic-recovery-field')?.visible).toBe(true)
      scene.setLessonTarget(null)
      expect(field.visible).toBe(false)
      expect(scene.getReference('hover-zone')?.object.visible).toBe(true)
    } finally {
      scene.dispose()
    }
  })

  it('anchors full-flip height and ground guides to raised ground rather than a configured airborne spawn', () => {
    const defaults = createDefaultDroneConfig()
    const config = { ...defaults, ground: { ...defaults.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 30, z: -3 } }
    const original = JSON.stringify(config)
    const scene = createFlightScene(config)
    try {
      const reference = scene.getReference('flip-zone')!
      expect(scene.sceneReferences.at(-9)?.id).toBe('flip-zone')
      expect(reference.kind).toBe('zone')
      expect(reference.positionM).toEqual({ x: 6, y: 15, z: -3 })
      expect(reference.object.position.toArray()).toEqual([6, 15, -3])
      expect(reference.sizeM).toEqual({ x: 160, y: 6, z: 160 })
      const floor = scene.scene.getObjectByName('flip-area-boundary') as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
      expect(floor.geometry.parameters.innerRadius).toBeCloseTo(79.93)
      expect(floor.geometry.parameters.outerRadius).toBe(80)
      expect(floor.getWorldPosition(floor.position.clone()).y).toBeCloseTo(5.025)
      const meshes: THREE.Object3D[] = []
      reference.object.traverse((object) => { if ((object as THREE.Mesh).isMesh) meshes.push(object) })
      expect(meshes).toEqual([floor])
      expect(floor.material.transparent).toBe(true)
      const band = scene.scene.getObjectByName('flip-height-band') as THREE.LineLoop<THREE.BufferGeometry>
      const bandPoints = band.geometry.getAttribute('position')
      expect(Array.from({ length: bandPoints.count }, (_, i) => bandPoints.getY(i) + reference.positionM.y)).toEqual([13, 13, 19, 19])
      const level = scene.scene.getObjectByName('flip-level-reference') as THREE.LineSegments<THREE.BufferGeometry>
      const levelPoints = level.geometry.getAttribute('position')
      expect(levelPoints.getY(0) + reference.positionM.y).toBe(15)
      expect(levelPoints.getY(1) + reference.positionM.y).toBe(15)
      expect(levelPoints.getX(0) + reference.positionM.x).toBe(-2)
      expect(levelPoints.getX(1) + reference.positionM.x).toBe(14)
      const up = scene.scene.getObjectByName('flip-world-up-reference') as THREE.LineSegments<THREE.BufferGeometry>
      expect(up.geometry.getAttribute('position').getY(1) + reference.positionM.y).toBe(17)
      const forward = scene.scene.getObjectByName('flip-forward-reference') as THREE.LineSegments<THREE.BufferGeometry>
      const backward = scene.scene.getObjectByName('flip-backward-reference') as THREE.LineSegments<THREE.BufferGeometry>
      const forwardPoints = forward.geometry.getAttribute('position')
      const backwardPoints = backward.geometry.getAttribute('position')
      expect(forwardPoints.getY(0) + reference.positionM.y).toBe(13)
      expect(backwardPoints.getY(0) + reference.positionM.y).toBe(13)
      expect(forwardPoints.getZ(1)).toBeLessThan(forwardPoints.getZ(0))
      expect(backwardPoints.getZ(1)).toBeGreaterThan(backwardPoints.getZ(0))
      expect(backwardPoints.count).toBeGreaterThan(forwardPoints.count)
      const worldDirection = rotateVectorByQuaternion(level.getWorldQuaternion(level.quaternion.clone()), { x: 1, y: 0, z: 0 })
      scene.applyState({ ...createInitialDroneState(config), orientation: { x: -1, y: 0, z: 0, w: 0 } })
      expect(rotateVectorByQuaternion(level.getWorldQuaternion(level.quaternion.clone()), { x: 1, y: 0, z: 0 })).toEqual(worldDirection)
      expect(JSON.stringify(config)).toBe(original)
    } finally {
      scene.dispose()
    }
  })

  it('disposes every full-flip guide including its hidden world-up marker', () => {
    const scene = createFlightScene()
    const resources = ['flip-area-boundary', 'flip-height-pole', 'flip-height-band', 'flip-level-reference', 'flip-world-up-reference', 'flip-forward-reference', 'flip-backward-reference'].flatMap((name) => {
      const object = scene.scene.getObjectByName(name) as THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
      return [object.geometry, object.material]
    })
    const dispose = resources.map((resource) => vi.spyOn(resource, 'dispose'))
    scene.dispose()
    for (const spy of dispose) expect(spy).toHaveBeenCalledOnce()
  })

  it('shows a non-solid illustrative loop without changing actual drone state or evaluator anchors', () => {
    const scene = createFlightScene()
    const field = scene.scene.getObjectByName('power-loop-field')!
    const accent = scene.scene.getObjectByName('loop-stage-guidance')!
    const guide = scene.scene.getObjectByName('loop-stage-reference') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
    const before = scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM: { ...positionM }, sizeM }))
    const drone = scene.drone.position.toArray()
    const ghost = scene.ghost.position.toArray()
    try {
      expect(field.visible).toBe(false)
      scene.setLessonTarget('power-loop')
      expect(field.visible).toBe(true)
      for (const name of ['full-flip-field', 'full-roll-field', 'basic-recovery-field', 'wide-gate-field', 'figure-eight-targets', 'square-route-targets', 'coordinated-turn-targets', 'straight-line-targets', 'landing-target', 'takeoff-height-target']) {
        expect(scene.scene.getObjectByName(name)?.visible).toBe(false)
      }
      for (const id of ['hover-zone', 'orbit-poi', 'split-s-reference']) expect(scene.getReference(id)?.object.visible).toBe(false)
      for (const [stage, color, y, z] of [[0, 0x45d7f7, 0, -18], [2, 0x45d7f7, 0, -18], [3, 0xffc978, 8, -26], [4, 0xffc978, 16, -18], [5, 0xffc978, 8, -10], [6, 0xffc978, 0, -18], [7, 0xb8f36b, 0, -24], [8, 0xb8f36b, 0, -24]]) {
        scene.setPowerLoopStage(stage)
        expect(accent.visible).toBe(true)
        expect(guide.material.color.getHex()).toBe(color)
        expect(accent.position.toArray()).toEqual([0, y, z])
      }
      for (const stage of [null, -1, 9, 1.5, Number.NaN]) {
        scene.setPowerLoopStage(stage)
        expect(accent.visible).toBe(false)
        expect(field.visible).toBe(true)
        expect(scene.scene.getObjectByName('loop-outline-left')?.visible).toBe(true)
      }
      expect(scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM, sizeM }))).toEqual(before)
      expect(scene.drone.position.toArray()).toEqual(drone)
      expect(scene.ghost.position.toArray()).toEqual(ghost)
      scene.setLessonTarget('back-flip')
      expect(field.visible).toBe(false)
      expect(scene.scene.getObjectByName('full-flip-field')?.visible).toBe(true)
      scene.setLessonTarget(null)
      expect(field.visible).toBe(false)
      expect(scene.getReference('hover-zone')?.object.visible).toBe(true)
    } finally {
      scene.dispose()
    }
  })

  it('anchors the illustrative loop to raised ground and keeps its outlines world-fixed and non-solid', () => {
    const defaults = createDefaultDroneConfig()
    const config = { ...defaults, ground: { ...defaults.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 30, z: -3 } }
    const original = JSON.stringify(config)
    const scene = createFlightScene(config)
    try {
      const reference = scene.getReference('loop-zone')!
      expect(scene.sceneReferences.at(-8)?.id).toBe('loop-zone')
      expect(reference.positionM).toEqual({ x: 6, y: 5 + POWER_LOOP_TARGET_HEIGHT_M, z: -3 })
      expect(reference.object.position.toArray()).toEqual([6, 5 + POWER_LOOP_TARGET_HEIGHT_M, -3])
      expect(reference.sizeM).toEqual({ x: 240, y: 16, z: 240 })
      const floor = scene.scene.getObjectByName('loop-area-boundary') as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
      expect(floor.geometry.parameters.outerRadius).toBe(120)
      expect(floor.getWorldPosition(floor.position.clone()).y).toBeCloseTo(5.025)
      const meshes: THREE.Object3D[] = []
      reference.object.traverse((object) => { if ((object as THREE.Mesh).isMesh) meshes.push(object) })
      expect(meshes).toEqual([floor])
      expect(floor.material.transparent).toBe(true)
      const outlines = ['left', 'right'].map((side) => scene.scene.getObjectByName(`loop-outline-${side}`) as THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>)
      for (const [index, outline] of outlines.entries()) {
        const points = outline.geometry.getAttribute('position')
        const heights = Array.from({ length: points.count }, (_, i) => points.getY(i) + reference.positionM.y)
        const depths = Array.from({ length: points.count }, (_, i) => points.getZ(i) + reference.positionM.z)
        expect(Math.min(...heights)).toBe(5 + POWER_LOOP_TARGET_HEIGHT_M)
        expect(Math.max(...heights)).toBe(5 + POWER_LOOP_TARGET_HEIGHT_M + 16)
        expect(Math.min(...depths)).toBe(-29)
        expect(Math.max(...depths)).toBe(-13)
        expect(points.getX(0)).toBe(index === 0 ? -5 : 5)
        expect(outline.material.isLineDashedMaterial).toBe(true)
        expect(outline.geometry.getAttribute('lineDistance')).toBeDefined()
      }
      const before = outlines.map((outline) => outline.getWorldQuaternion(outline.quaternion.clone()).toArray())
      scene.applyState({ ...createInitialDroneState(config), orientation: { x: -1, y: 0, z: 0, w: 0 } })
      expect(outlines.map((outline) => outline.getWorldQuaternion(outline.quaternion.clone()).toArray())).toEqual(before)
      expect(JSON.stringify(config)).toBe(original)
    } finally {
      scene.dispose()
    }
  })

  it('disposes all loop outline, boundary, height and stage resources exactly once', () => {
    const scene = createFlightScene()
    const resources = ['loop-area-boundary', 'loop-outline-left', 'loop-outline-right', 'loop-height-poles', 'loop-stage-reference'].flatMap((name) => {
      const object = scene.scene.getObjectByName(name) as THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
      return [object.geometry, object.material]
    })
    const dispose = resources.map((resource) => vi.spyOn(resource, 'dispose'))
    scene.dispose()
    for (const spy of dispose) expect(spy).toHaveBeenCalledOnce()
  })

  it('guides ground entry, inverted descent and reversed exit without changing flight or legacy anchors', () => {
    const scene = createFlightScene()
    const field = scene.scene.getObjectByName('split-s-field')!
    const accent = scene.scene.getObjectByName('split-stage-guidance')!
    const guide = scene.scene.getObjectByName('split-stage-reference') as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>
    const before = scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM: { ...positionM }, sizeM }))
    const drone = scene.drone.position.toArray()
    const ghost = scene.ghost.position.toArray()
    try {
      expect(field.visible).toBe(false)
      scene.setLessonTarget('split-s')
      expect(field.visible).toBe(true)
      for (const name of ['power-loop-field', 'full-flip-field', 'full-roll-field', 'basic-recovery-field', 'wide-gate-field', 'figure-eight-targets', 'square-route-targets', 'coordinated-turn-targets', 'straight-line-targets', 'landing-target', 'takeoff-height-target']) {
        expect(scene.scene.getObjectByName(name)?.visible).toBe(false)
      }
      for (const id of ['hover-zone', 'orbit-poi', 'split-s-reference']) expect(scene.getReference(id)?.object.visible).toBe(false)
      for (const [stage, color, y, z] of [[0, 0x45d7f7, -SPLIT_S_TARGET_HEIGHT_M + 0.1, 0], [1, 0x45d7f7, 0, -40], [2, 0x45d7f7, 0, -40], [3, 0xffc978, 0, -44], [4, 0xffc978, -8, -52], [5, 0xffc978, -16, -44], [6, 0xffc978, -16, -39], [7, 0xb8f36b, -16, -32], [8, 0xb8f36b, -16, -32]]) {
        scene.setSplitSStage(stage)
        expect(accent.visible).toBe(true)
        expect(guide.material.color.getHex()).toBe(color)
        expect(accent.position.toArray()).toEqual([0, y, z])
        expect(accent.rotation.y).toBe(stage >= 5 ? Math.PI : 0)
      }
      for (const stage of [null, -1, 9, 1.5, Number.NaN]) {
        scene.setSplitSStage(stage)
        expect(accent.visible).toBe(false)
        expect(field.visible).toBe(true)
        expect(scene.scene.getObjectByName('split-outline-left')?.visible).toBe(true)
      }
      expect(scene.sceneReferences.map(({ id, positionM, sizeM }) => ({ id, positionM, sizeM }))).toEqual(before)
      expect(scene.drone.position.toArray()).toEqual(drone)
      expect(scene.ghost.position.toArray()).toEqual(ghost)
      scene.setLessonTarget('power-loop')
      expect(field.visible).toBe(false)
      expect(scene.scene.getObjectByName('power-loop-field')?.visible).toBe(true)
      scene.setLessonTarget(null)
      expect(field.visible).toBe(false)
      expect(scene.getReference('split-s-reference')?.object.visible).toBe(true)
    } finally {
      scene.dispose()
    }
  })

  it('anchors split descent guides above configured ground without solid obstacles or a forced airborne spawn', () => {
    const defaults = createDefaultDroneConfig()
    const config = { ...defaults, ground: { ...defaults.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } }
    const original = JSON.stringify(config)
    const scene = createFlightScene(config)
    try {
      const reference = scene.getReference('split-zone')!
      expect(scene.sceneReferences.at(-7)?.id).toBe('split-zone')
      expect(reference.positionM).toEqual({ x: 6, y: 5 + SPLIT_S_TARGET_HEIGHT_M, z: -3 })
      expect(reference.object.position.toArray()).toEqual([6, 5 + SPLIT_S_TARGET_HEIGHT_M, -3])
      expect(reference.sizeM).toEqual({ x: 300, y: SPLIT_S_TARGET_HEIGHT_M - SPLIT_S_MIN_HEIGHT_M, z: 300 })
      const floor = scene.scene.getObjectByName('split-area-boundary') as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
      expect(floor.geometry.parameters.outerRadius).toBe(150)
      expect(floor.getWorldPosition(floor.position.clone()).y).toBeCloseTo(5.025)
      const meshes: THREE.Object3D[] = []
      reference.object.traverse((object) => { if ((object as THREE.Mesh).isMesh) meshes.push(object) })
      expect(meshes[0]).toBe(floor)
      expect(meshes.filter((object) => object.name.startsWith('split-reference-'))).toHaveLength(21)
      expect(floor.material.transparent).toBe(true)
      for (const [index, side] of ['left', 'right'].entries()) {
        const outline = scene.scene.getObjectByName(`split-outline-${side}`) as THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>
        const points = outline.geometry.getAttribute('position')
        const heights = Array.from({ length: points.count }, (_, i) => points.getY(i) + reference.positionM.y)
        const depths = Array.from({ length: points.count }, (_, i) => points.getZ(i) + reference.positionM.z)
        expect(Math.max(...heights)).toBe(5 + SPLIT_S_TARGET_HEIGHT_M)
        expect(Math.min(...heights)).toBe(5 + SPLIT_S_TARGET_HEIGHT_M - 16)
        expect(Math.min(...depths)).toBe(-55)
        expect(Math.max(...depths)).toBe(-47)
        expect(points.getX(0)).toBe(index === 0 ? -5 : 5)
        expect(outline.material.isLineDashedMaterial).toBe(true)
        expect(outline.geometry.getAttribute('lineDistance')).toBeDefined()
      }
      const exit = scene.scene.getObjectByName('split-reversed-exit') as THREE.LineSegments<THREE.BufferGeometry>
      const exitPoints = exit.geometry.getAttribute('position')
      expect(exitPoints.getZ(1)).toBeGreaterThan(exitPoints.getZ(0))
      const before = reference.object.quaternion.toArray()
      scene.applyState({ ...createInitialDroneState(config), orientation: { x: 1, y: 0, z: 0, w: 0 } })
      expect(reference.object.quaternion.toArray()).toEqual(before)
      scene.setSplitSStage(0)
      const groundGuide = scene.scene.getObjectByName('split-stage-guidance')!
      expect(groundGuide.getWorldPosition(groundGuide.position.clone()).y).toBeCloseTo(5.1)
      expect(JSON.stringify(config)).toBe(original)
    } finally {
      scene.dispose()
    }
  })

  it('disposes every split descent outline, floor, height band and direction marker exactly once', () => {
    const scene = createFlightScene()
    const resources = ['split-area-boundary', 'split-outline-left', 'split-outline-right', 'split-height-poles', 'split-entry-height-band', 'split-over-beam-approach', 'split-reversed-exit', 'split-stage-reference'].flatMap((name) => {
      const object = scene.scene.getObjectByName(name) as THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
      return [object.geometry, object.material]
    })
    const dispose = resources.map((resource) => vi.spyOn(resource, 'dispose'))
    scene.dispose()
    for (const spy of dispose) expect(spy).toHaveBeenCalledOnce()
  })

  it('shows an opaque orange gantry between the retained upper approach and lower reverse-exit paths', () => {
    const defaults = createDefaultDroneConfig()
    const config = { ...defaults, ground: { ...defaults.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } }
    const scene = createFlightScene(config)
    const gantry = scene.scene.getObjectByName('split-reference-gantry')!
    const beam = scene.scene.getObjectByName('split-reference-beam') as THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>
    scene.scene.updateMatrixWorld(true)
    const resourceDisposals: ReturnType<typeof vi.spyOn>[] = []
    try {
      expect(gantry.parent).toBe(scene.getReference('split-zone')?.object)
      expect(gantry.userData).toEqual({ teachingReference: '破S 參考橫樑', collision: false })
      expect(beam.geometry.parameters).toMatchObject({ width: 22, height: 1, depth: 2 })
      expect(beam.material.transparent).toBe(false)
      expect(beam.material.opacity).toBe(1)
      expect(beam.material.color.getHex()).toBe(0xffba52)
      const bounds = new THREE.Box3().setFromObject(beam)
      expect(bounds.min.toArray()).toEqual([-5, 22.5, -44])
      expect(bounds.max.toArray()).toEqual([17, 23.5, -42])
      const before = beam.matrixWorld.toArray()
      scene.setLessonTarget('split-s')
      for (const phase of [0, 3, 4, 8, null]) {
        scene.setSplitSStage(phase)
        expect(beam.visible).toBe(true)
        expect(scene.getReference('split-zone')?.object.visible).toBe(true)
        expect(scene.scene.getObjectByName('split-outline-left')?.visible).toBe(true)
        expect(beam.matrixWorld.toArray()).toEqual(before)
      }
      const approach = scene.scene.getObjectByName('split-over-beam-approach') as THREE.LineSegments<THREE.BufferGeometry>
      const exit = scene.scene.getObjectByName('split-reversed-exit') as THREE.LineSegments<THREE.BufferGeometry>
      expect(approach.geometry.getAttribute('position').getY(0) + 5 + SPLIT_S_TARGET_HEIGHT_M).toBeGreaterThan(bounds.max.y + 3)
      expect(exit.geometry.getAttribute('position').getY(0) + 5 + SPLIT_S_TARGET_HEIGHT_M).toBeLessThan(bounds.min.y - 3)
      scene.setLessonTarget('power-loop')
      expect(gantry.parent?.visible).toBe(false)
      const resources = new Set<THREE.BufferGeometry | THREE.Material>()
      gantry.traverse((object) => {
        const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
        if (!mesh.isMesh) return
        resources.add(mesh.geometry)
        resources.add(mesh.material)
      })
      for (const resource of resources) resourceDisposals.push(vi.spyOn(resource, 'dispose'))
    } finally { scene.dispose() }
    for (const spy of resourceDisposals) expect(spy).toHaveBeenCalledOnce()
  })

  it.each(['beginner', 'standard', 'raised-field'] as const)('keeps the actual %s demonstration above then below the reference beam without intersecting its visible structure', (preset) => {
    const base = createTuningPreset(preset === 'standard' ? 'standard' : 'beginner')
    const settings = preset === 'raised-field' ? { ...base, drone: { ...base.drone,
      ground: { ...base.drone.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } } } : base
    const scene = createFlightScene(settings.drone)
    try {
      scene.scene.updateMatrixWorld(true)
      const beam = scene.scene.getObjectByName('split-reference-beam')!
      const gantry = scene.scene.getObjectByName('split-reference-gantry')!
      const beamBounds = new THREE.Box3().setFromObject(beam)
      const centerZ = beam.getWorldPosition(new THREE.Vector3()).z
      const bounds: THREE.Box3[] = []
      gantry.traverse((object) => { if ((object as THREE.Mesh).isMesh) bounds.push(new THREE.Box3().setFromObject(object).expandByScalar(0.5)) })
      const demo = createTeachingDemonstration(settings, 'split-s')
      let over = false
      let under = false
      for (const [index, sample] of demo.recording.samples.entries()) {
        const position = new THREE.Vector3(sample.positionM.x, sample.positionM.y, sample.positionM.z)
        expect(bounds.some((box) => box.containsPoint(position)), `structure overlap at ${sample.timestampSeconds}s`).toBe(false)
        const previous = demo.recording.samples[index - 1]
        if (!previous) continue
        if (previous.positionM.z > centerZ && sample.positionM.z <= centerZ) {
          expect(sample.positionM.y).toBeGreaterThan(beamBounds.max.y + 3)
          over = true
        }
        if (previous.positionM.z < centerZ && sample.positionM.z >= centerZ) {
          expect(sample.positionM.y).toBeLessThan(beamBounds.min.y - 3)
          under = true
        }
      }
      expect({ over, under }).toEqual({ over: true, under: true })
    } finally { scene.dispose() }
  })

  it('appends a ground-relative orbit subject while preserving the legacy POI and supporting either orbit direction', () => {
    const defaults = createDefaultDroneConfig()
    const config = { ...defaults, ground: { ...defaults.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } }
    const original = JSON.stringify(config)
    const scene = createFlightScene(config)
    try {
      const field = scene.getReference('orbit-zone')!
      const launch = scene.getReference('training-launch')!.positionM
      const target = createOrbitTarget(launch, config.ground.heightM)
      expect(scene.sceneReferences.at(-6)?.id).toBe('orbit-zone')
      expect(field.positionM).toEqual(target)
      expect(field.object.position.toArray()).toEqual([target.x, target.y, target.z])
      expect(field.sizeM?.x).toBe(ORBIT_MAX_RADIUS_M * 2)
      expect(scene.getReference('orbit-poi')?.positionM).toEqual({ x: 4, y: 7.5, z: 4 })
      expect(field.object.visible).toBe(false)
      scene.setLessonTarget('orbit')
      expect(field.object.visible).toBe(true)
      expect(scene.getReference('orbit-poi')?.object.visible).toBe(false)
      for (const name of ['split-s-field', 'power-loop-field', 'full-flip-field', 'wide-gate-field', 'straight-line-targets']) {
        expect(scene.scene.getObjectByName(name)?.visible).toBe(false)
      }
      const tower = scene.scene.getObjectByName('orbit-reference-tower')!
      const column = scene.scene.getObjectByName('orbit-reference-column') as THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>
      expect(tower.userData).toEqual({ teachingReference: '正刷鍋參考塔', collision: false })
      expect(column.material.transparent).toBe(false)
      scene.scene.updateMatrixWorld(true)
      const bounds = new THREE.Box3().setFromObject(column)
      expect(bounds.min.y).toBeCloseTo(config.ground.heightM)
      expect(bounds.max.y).toBeCloseTo(config.ground.heightM + ORBIT_TARGET_HEIGHT_M + 2)
      const route = scene.scene.getObjectByName('orbit-route-ring') as THREE.LineLoop<THREE.BufferGeometry>
      const points = route.geometry.getAttribute('position')
      for (let index = 0; index < points.count; index += 1) {
        expect(Math.hypot(points.getX(index), points.getZ(index))).toBeCloseTo(ORBIT_TARGET_RADIUS_M, 5)
        expect(points.getY(index)).toBe(0)
      }
      expect(scene.scene.getObjectByName('orbit-quarter-markers')?.children).toHaveLength(4)
      const towerPose = tower.matrixWorld.clone()
      const drone = scene.drone.position.clone()
      const accent = scene.scene.getObjectByName('orbit-stage-guidance')!
      const exit = scene.scene.getObjectByName('orbit-outward-exit-reference') as THREE.LineSegments<THREE.BufferGeometry>
      const exitPoints = exit.geometry.getAttribute('position')
      for (let index = 0; index < exitPoints.count; index += 6) {
        const tail = new THREE.Vector3().fromBufferAttribute(exitPoints, index)
        const tip = new THREE.Vector3().fromBufferAttribute(exitPoints, index + 1)
        expect(tip.length()).toBeGreaterThan(tail.length() + 3)
        expect(tip.clone().normalize().dot(tail.clone().normalize())).toBeCloseTo(1)
      }
      const guide = scene.scene.getObjectByName('orbit-stage-reference') as THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>
      for (const stage of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        scene.setOrbitStage(stage)
        expect(accent.visible).toBe(true)
        expect(exit.visible).toBe(stage >= 8)
        expect(guide.material.color.getHex()).toBe(stage >= 9 ? 0xb8f36b : stage >= 3 ? 0xffc978 : 0x45d7f7)
        expect(tower.matrixWorld.equals(towerPose)).toBe(true)
        expect(scene.drone.position.equals(drone)).toBe(true)
      }
      for (const stage of [null, -1, 10, 1.5, Number.NaN]) {
        scene.setOrbitStage(stage)
        expect(accent.visible).toBe(false)
        expect(exit.visible).toBe(false)
        expect(route.visible).toBe(true)
        expect(tower.visible).toBe(true)
      }
      scene.setLessonTarget('split-s')
      expect(field.object.visible).toBe(false)
      scene.setLessonTarget(null)
      expect(scene.getReference('orbit-poi')?.object.visible).toBe(true)
      expect(JSON.stringify(config)).toBe(original)
    } finally { scene.dispose() }
  })

  it('disposes the orbit subject, corridor, quadrant guides and stage resources once', () => {
    const scene = createFlightScene()
    const resources = new Set<THREE.BufferGeometry | THREE.Material>()
    scene.getReference('orbit-zone')!.object.traverse((object) => {
      const visual = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
      if (visual.geometry) resources.add(visual.geometry)
      for (const material of Array.isArray(visual.material) ? visual.material : visual.material ? [visual.material] : []) resources.add(material)
    })
    const disposals = [...resources].map((resource) => vi.spyOn(resource, 'dispose'))
    scene.dispose()
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce()
  })

  it('appends a broad ground-relative backward corridor with distinct landmarks visible from either heading', () => {
    const defaults = createDefaultDroneConfig()
    const config = { ...defaults, ground: { ...defaults.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } }
    const original = JSON.stringify(config)
    const scene = createFlightScene(config)
    try {
      const reference = scene.getReference('backward-zone')!
      expect(scene.sceneReferences.at(-5)?.id).toBe('backward-zone')
      expect(reference.positionM).toEqual({ x: 6, y: 15, z: -28 })
      expect(reference.sizeM).toEqual({ x: 28, y: 20, z: 64 })
      expect(reference.object.position.toArray()).toEqual([6, 15, -28])
      expect(reference.object.userData).toEqual({ teachingReference: '後退飛行寬走廊', collision: false })
      expect(reference.object.visible).toBe(false)
      const anchors = scene.sceneReferences.map(({ id, positionM }) => ({ id, positionM: { ...positionM } }))
      scene.setLessonTarget('backward-flight')
      expect(reference.object.visible).toBe(true)
      for (const name of ['orbit-field', 'split-s-field', 'power-loop-field', 'full-flip-field', 'wide-gate-field', 'straight-line-targets']) {
        expect(scene.scene.getObjectByName(name)?.visible).toBe(false)
      }
      for (const id of ['hover-zone', 'orbit-poi', 'split-s-reference']) expect(scene.getReference(id)?.object.visible).toBe(false)
      const arrival = scene.scene.getObjectByName('backward-arrival-landmark')!
      const departure = scene.scene.getObjectByName('backward-departure-landmark')!
      expect(arrival.children.filter(({ name }) => name.includes('-column-'))).toHaveLength(2)
      expect(departure.children.filter(({ name }) => name.includes('-column-'))).toHaveLength(3)
      scene.scene.updateMatrixWorld(true)
      expect(arrival.getWorldPosition(new THREE.Vector3()).z).toBe(7)
      expect(departure.getWorldPosition(new THREE.Vector3()).z).toBe(-43)
      for (const landmark of [arrival, departure]) {
        const column = landmark.children.find(({ name }) => name.includes('-column-')) as THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>
        const bounds = new THREE.Box3().setFromObject(column)
        expect(bounds.min.y).toBeCloseTo(5)
        expect(bounds.max.y).toBeCloseTo(19)
        expect(column.material.transparent).toBe(false)
      }
      const travel = scene.scene.getObjectByName('backward-original-travel-guide') as THREE.LineSegments<THREE.BufferGeometry>
      const points = travel.geometry.getAttribute('position')
      for (let index = 0; index < points.count; index += 6) expect(points.getZ(index + 1)).toBeLessThan(points.getZ(index))
      const corridor = scene.scene.getObjectByName('backward-broad-corridor') as THREE.LineSegments<THREE.BufferGeometry>
      corridor.geometry.computeBoundingBox()
      expect(corridor.geometry.boundingBox!.min.x).toBeCloseTo(-14.6)
      expect(corridor.geometry.boundingBox!.max.x).toBeCloseTo(14.6)
      const dronePose = scene.drone.matrixWorld.clone()
      const arrivalPose = arrival.matrixWorld.clone()
      const accent = scene.scene.getObjectByName('backward-stage-guidance')!
      const nose = scene.scene.getObjectByName('backward-nose-direction-example')!
      const momentum = scene.scene.getObjectByName('backward-travel-direction-example')!
      const guide = scene.scene.getObjectByName('backward-stage-reference') as THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>
      for (const stage of [0, 1, 2, 3, 4, 5, 6, 7]) {
        scene.setBackwardFlightStage(stage)
        expect(accent.visible).toBe(true)
        expect(guide.material.color.getHex()).toBe(stage >= 6 ? 0xb8f36b : stage >= 2 ? 0xffc978 : 0x45d7f7)
        expect(nose.rotation.y).toBe(stage >= 3 ? Math.PI : 0)
        expect(momentum.rotation.y).toBe(0)
        expect(scene.drone.matrixWorld.equals(dronePose)).toBe(true)
        expect(arrival.matrixWorld.equals(arrivalPose)).toBe(true)
      }
      for (const stage of [null, -1, 8, 1.5, Number.NaN]) {
        scene.setBackwardFlightStage(stage)
        expect(accent.visible).toBe(false)
        expect(travel.visible).toBe(true)
        expect(arrival.visible).toBe(true)
        expect(departure.visible).toBe(true)
      }
      expect(scene.sceneReferences.map(({ id, positionM }) => ({ id, positionM }))).toEqual(anchors)
      scene.setLessonTarget('orbit')
      expect(reference.object.visible).toBe(false)
      scene.setLessonTarget(null)
      expect(scene.getReference('orbit-poi')?.object.visible).toBe(true)
      expect(JSON.stringify(config)).toBe(original)
    } finally { scene.dispose() }
  })

  it('disposes every backward corridor, landmark and direction-example resource once', () => {
    const scene = createFlightScene()
    const resources = new Set<THREE.BufferGeometry | THREE.Material>()
    scene.getReference('backward-zone')!.object.traverse((object) => {
      const visual = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
      if (visual.geometry) resources.add(visual.geometry)
      for (const material of Array.isArray(visual.material) ? visual.material : visual.material ? [visual.material] : []) resources.add(material)
    })
    const disposals = [...resources].map((resource) => vi.spyOn(resource, 'dispose'))
    scene.dispose()
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce()
  })


  it('provides a raised-ground tower crane with open jib, counterjib and hook while preserving existing anchors', () => {
    const defaults = createDefaultDroneConfig()
    const config = { ...defaults, ground: { ...defaults.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } }
    const original = JSON.stringify(config)
    const scene = createFlightScene(config)
    try {
      const reference = scene.getReference('reverse-orbit-zone')!
      const launch = scene.getReference('training-launch')!.positionM
      const target = createReverseOrbitTarget(launch, config.ground.heightM)
      expect(scene.sceneReferences.at(-4)?.id).toBe('reverse-orbit-zone')
      expect(reference.positionM).toEqual({ x: 6, y: 50, z: -33 })
      expect(reference.positionM).toEqual(target)
      expect(reference.object.position.toArray()).toEqual([target.x, target.y, target.z])
      expect(scene.getReference('orbit-poi')?.positionM).toEqual({ x: 4, y: 7.5, z: 4 })
      expect(scene.getReference('orbit-zone')?.positionM).toEqual({ x: 6, y: 15, z: -33 })
      expect(scene.getReference('backward-zone')?.positionM).toEqual({ x: 6, y: 15, z: -28 })
      const anchors = scene.sceneReferences.map(({ id, positionM }) => ({ id, positionM: { ...positionM } }))
      expect(reference.object.visible).toBe(false)
      scene.setLessonTarget('reverse-orbit')
      expect(reference.object.visible).toBe(true)
      for (const name of ['orbit-field', 'backward-field', 'split-s-field', 'power-loop-field', 'wide-gate-field']) {
        expect(scene.scene.getObjectByName(name)?.visible).toBe(false)
      }
      expect(scene.getReference('orbit-poi')?.object.visible).toBe(false)
      const crane = scene.scene.getObjectByName('reverse-orbit-crane')!
      expect(crane.userData).toEqual({ teachingReference: '倒刷鍋塔式起重機與高處機臂', collision: false })
      scene.scene.updateMatrixWorld(true)
      const mast = scene.scene.getObjectByName('reverse-orbit-crane-mast')!
      const mastBounds = new THREE.Box3().setFromObject(mast)
      expect(mastBounds.min.y).toBeCloseTo(config.ground.heightM)
      expect(mastBounds.max.y).toBeCloseTo(config.ground.heightM + REVERSE_ORBIT_TARGET_HEIGHT_M)
      const jib = scene.scene.getObjectByName('reverse-orbit-crane-jib')!
      const counterJib = scene.scene.getObjectByName('reverse-orbit-crane-counter-jib')!
      const jibBounds = new THREE.Box3().setFromObject(jib)
      const counterBounds = new THREE.Box3().setFromObject(counterJib)
      expect(jibBounds.max.x).toBeCloseTo(target.x + 24, 1)
      expect(counterBounds.min.x).toBeCloseTo(target.x - 10, 1)
      for (const name of ['cabin', 'lattice', 'head-mast', 'support-and-hook-cables', 'hook-block', 'hook']) {
        expect(scene.scene.getObjectByName(`reverse-orbit-crane-${name}`)).toBeDefined()
      }
      for (let index = 0; index < 3; index += 1) expect(scene.scene.getObjectByName(`reverse-orbit-crane-counterweight-${index}`)).toBeDefined()
      const underside = scene.scene.getObjectByName('reverse-orbit-crane-jib-underside') as THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>
      expect(underside.material.transparent).toBe(false)
      expect(underside.material.emissiveIntensity).toBeGreaterThan(0)
      const route = scene.scene.getObjectByName('reverse-orbit-route-ring') as THREE.LineLoop<THREE.BufferGeometry>
      const positions = route.geometry.getAttribute('position')
      for (let index = 0; index < positions.count; index += 1) {
        expect(Math.hypot(positions.getX(index), positions.getZ(index))).toBeCloseTo(REVERSE_ORBIT_TARGET_RADIUS_M, 5)
        expect(positions.getY(index)).toBe(REVERSE_ORBIT_FLIGHT_HEIGHT_M - REVERSE_ORBIT_TARGET_HEIGHT_M)
      }
      const before = crane.matrixWorld.clone()
      const drone = scene.drone.matrixWorld.clone()
      const accent = scene.scene.getObjectByName('reverse-orbit-stage-guidance')!
      const exit = scene.scene.getObjectByName('reverse-orbit-outward-exit-reference')!
      const guide = scene.scene.getObjectByName('reverse-orbit-stage-reference') as THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>
      for (const stage of [0, 1, 2, 3, 4, 5, 6, 7]) {
        scene.setReverseOrbitStage(stage)
        expect(accent.visible).toBe(true)
        expect(exit.visible).toBe(stage >= 6)
        expect(guide.material.color.getHex()).toBe(stage >= 7 ? 0xb8f36b : stage >= 3 ? 0xffc978 : 0x45d7f7)
        expect(crane.matrixWorld.equals(before)).toBe(true)
        expect(scene.drone.matrixWorld.equals(drone)).toBe(true)
      }
      for (const stage of [null, -1, 8, 1.5, Number.NaN]) {
        scene.setReverseOrbitStage(stage)
        expect(accent.visible).toBe(false)
        expect(exit.visible).toBe(false)
        expect(jib.visible).toBe(true)
        expect(crane.visible).toBe(true)
      }
      expect(scene.sceneReferences.map(({ id, positionM }) => ({ id, positionM }))).toEqual(anchors)
      scene.setLessonTarget(null)
      expect(reference.object.visible).toBe(false)
      expect(scene.getReference('orbit-poi')?.object.visible).toBe(true)
      expect(JSON.stringify(config)).toBe(original)
    } finally { scene.dispose() }
  })

  it('disposes shared crane steel, lattice, route and stage resources exactly once', () => {
    const scene = createFlightScene()
    const resources = new Set<THREE.BufferGeometry | THREE.Material>()
    scene.getReference('reverse-orbit-zone')!.object.traverse((object) => {
      const visual = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
      if (visual.geometry) resources.add(visual.geometry)
      for (const material of Array.isArray(visual.material) ? visual.material : visual.material ? [visual.material] : []) resources.add(material)
    })
    const disposals = [...resources].map((resource) => vi.spyOn(resource, 'dispose'))
    scene.dispose()
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce()
  })

  it('keeps the real beginner FPV camera facing a visible crane jib throughout the three measured circles', () => {
    const settings = createTuningPreset('beginner')
    const scene = createFlightScene(settings.drone)
    try {
      scene.setLessonTarget('reverse-orbit')
      scene.scene.updateMatrixWorld(true)
      const jib = scene.scene.getObjectByName('reverse-orbit-crane-jib')!
      const bounds = new THREE.Box3().setFromObject(jib)
      const demo = createTeachingDemonstration(settings, 'reverse-orbit')
      const rig = createCameraRig(settings.camera)
      let observations = 0
      for (const [index, sample] of demo.recording.samples.entries()) {
        const phase = teachingReverseOrbitPhaseAt(demo, sample.timestampSeconds)
        if (index % 20 !== 0 || phase === null || phase < 3 || phase >= 6) continue
        const camera = updateCameraRig(rig, { ...createInitialDroneState(settings.drone), ...sample }, 'fpv')
        camera.updateMatrixWorld(true)
        const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
        expect(new THREE.Frustum().setFromProjectionMatrix(matrix).intersectsBox(bounds)).toBe(true)
        observations += 1
      }
      expect(observations).toBeGreaterThan(20)
    } finally { scene.dispose() }
  })

  it('renders the smaller two-level gravity frame exactly with a horizontal top and low return exit on raised ground', () => {
    const defaults = createDefaultDroneConfig()
    const config = { ...defaults, ground: { ...defaults.ground, heightM: 5 }, spawnPositionM: { x: 6, y: 35, z: -3 } }
    const original = JSON.stringify(config)
    const scene = createFlightScene(config)
    try {
      const launch = scene.getReference('training-launch')!.positionM
      const gate = createGravityGate(launch, config.ground.heightM)
      const reference = scene.getReference('gravity-gate-frame')!
      expect(scene.sceneReferences.slice(-4).map(({ id }) => id)).toEqual([
        'reverse-orbit-zone', 'gravity-gate-frame', 'gravity-gate-top-entry', 'gravity-gate-side-exit',
      ])
      expect(reference.kind).toBe('gate')
      expect(reference.positionM).toEqual({ x: 6, y: 14, z: -31 })
      expect(reference.sizeM).toEqual({ x: 8, y: 10, z: 8 })
      expect(scene.getReference('gravity-gate-top-entry')!.positionM).toEqual({ x: 6, y: 19, z: -31 })
      expect(scene.getReference('gravity-gate-side-exit')!.positionM).toEqual(gate.sideExitCenterM)
      expect(gate.sideExitCenterM.x).toBe(10)
      expect(gate.sideExitCenterM.y).toBeCloseTo(11.43)
      expect(scene.getReference('gravity-gate-side-exit')!.sizeM).toEqual({ x: 0,
        y: gate.lowerExitMaxY - gate.lowerExitMinY, z: 8 })
      expect(reference.object.visible).toBe(false)
      scene.setLessonTarget('gravity-gate')
      expect(reference.object.visible).toBe(true)
      for (const name of ['reverse-orbit-field', 'backward-field', 'orbit-field', 'split-s-field', 'wide-gate-field']) {
        expect(scene.scene.getObjectByName(name)?.visible).toBe(false)
      }
      expect(scene.getReference('orbit-poi')?.object.visible).toBe(false)
      scene.scene.updateMatrixWorld(true)
      const frame = scene.scene.getObjectByName('gravity-gate-physical-frame')!
      expect(frame.children).toHaveLength(16)
      expect(frame.children.filter(({ name }) => name.includes('-middle-'))).toHaveLength(4)
      expect(frame.children).toHaveLength(gate.colliders.length)
      for (const collider of gate.colliders) {
        const beam = scene.scene.getObjectByName(collider.id) as THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>
        const position = beam.getWorldPosition(new THREE.Vector3())
        expect(position.x).toBeCloseTo(collider.centerM.x, 10)
        expect(position.y).toBeCloseTo(collider.centerM.y, 10)
        expect(position.z).toBeCloseTo(collider.centerM.z, 10)
        expect(beam.geometry.parameters.width).toBe(collider.halfExtentsM.x * 2)
        expect(beam.geometry.parameters.height).toBe(collider.halfExtentsM.y * 2)
        expect(beam.geometry.parameters.depth).toBe(collider.halfExtentsM.z * 2)
        expect(beam.material.transparent).toBe(false)
        expect(beam.userData.physicalColliderId).toBe(collider.id)
      }
      const topGuide = scene.getReference('gravity-gate-top-entry')!.object
      const sideGuide = scene.getReference('gravity-gate-side-exit')!.object
      expect(topGuide.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([6, 19, -31])
      const sidePosition = sideGuide.getWorldPosition(new THREE.Vector3())
      expect(sidePosition.x).toBe(gate.exitX)
      expect(sidePosition.y).toBeCloseTo(gate.sideExitCenterM.y)
      expect(sidePosition.z).toBe(gate.centerM.z)
      const topOpening = scene.scene.getObjectByName('gravity-gate-top-opening-guide') as THREE.LineLoop
      const sideOpening = scene.scene.getObjectByName('gravity-gate-side-opening-guide') as THREE.LineLoop
      expect(topOpening.isLineLoop).toBe(true)
      expect(sideOpening.isLineLoop).toBe(true)
      expect(frame.children.every((child) => (child as THREE.Mesh).isMesh)).toBe(true)
      expect(scene.scene.getObjectByName('gravity-gate-downward-entry-arrow')).toBeDefined()
      expect(scene.scene.getObjectByName('gravity-gate-outward-exit-arrow')).toBeDefined()
      expect(scene.scene.getObjectByName('gravity-gate-side-approach-arrow')).toBeDefined()
      expect(scene.scene.getObjectByName('gravity-gate-descend-to-lower-arrow')).toBeDefined()
      expect(scene.scene.getObjectByName('gravity-gate-height-guide')).toBeDefined()
      expect(scene.scene.getObjectByName('gravity-gate-illustrative-route')).toBeDefined()
      expect(JSON.stringify(config)).toBe(original)
      scene.setLessonTarget(null)
      expect(reference.object.visible).toBe(false)
      expect(scene.getReference('orbit-poi')?.object.visible).toBe(true)
    } finally { scene.dispose() }
  })

  it('illustrates a side approach, downward top entry, lower descent and opposite return without a path through beams', () => {
    const scene = createFlightScene()
    try {
      scene.setLessonTarget('gravity-gate')
      scene.scene.updateMatrixWorld(true)
      const launch = scene.getReference('training-launch')!.positionM
      const gate = createGravityGate(launch, 0)
      const approach = scene.scene.getObjectByName('gravity-gate-side-approach')!
      expect(approach.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([
        gate.approachPointM.x, gate.approachPointM.y, gate.approachPointM.z,
      ])
      for (const [name, direction] of [['gravity-gate-side-approach-arrow', [-1, 0, 0]],
        ['gravity-gate-outward-exit-arrow', [1, 0, 0]], ['gravity-gate-descend-to-lower-arrow', [0, -1, 0]]] as const) {
        const arrow = scene.scene.getObjectByName(name)!
        const measured = new THREE.Vector3(0, 1, 0).applyQuaternion(arrow.quaternion)
        for (const [axis, index] of [['x', 0], ['y', 1], ['z', 2]] as const) expect(measured[axis]).toBeCloseTo(direction[index], 10)
      }
      const exit = scene.scene.getObjectByName('gravity-gate-side-opening-guide') as THREE.LineLoop<THREE.BufferGeometry>
      const exitPoints = exit.geometry.getAttribute('position')
      for (let index = 0; index < exitPoints.count; index += 1) {
        const point = exit.localToWorld(new THREE.Vector3().fromBufferAttribute(exitPoints, index))
        expect(point.x).toBeCloseTo(gate.exitX + 0.05)
        expect(point.y).toBeGreaterThan(gate.lowerExitMinY)
        expect(point.y).toBeLessThan(gate.lowerExitMaxY)
        expect(point.z).toBeGreaterThan(gate.minZ)
        expect(point.z).toBeLessThan(gate.maxZ)
      }
      const route = scene.scene.getObjectByName('gravity-gate-illustrative-route') as THREE.Line<THREE.BufferGeometry>
      const points = route.geometry.getAttribute('position')
      let enteredAt = -1
      let lowerAt = -1
      let exitAt = -1
      for (let index = 1; index < points.count; index += 1) {
        const before = route.localToWorld(new THREE.Vector3().fromBufferAttribute(points, index - 1))
        const current = route.localToWorld(new THREE.Vector3().fromBufferAttribute(points, index))
        expect(findSweptObstacleHit(before, current, 0.3, gate.colliders), `route segment ${index}`).toBeNull()
        if (gravityGateTopCrossing(before, current, gate, 0.3)?.insideOpening) {
          expect(current.x).toBeLessThan(before.x)
          enteredAt = index
        }
        if (gravityGateLowerCrossing(before, current, gate, 0.3)?.insideOpening) lowerAt = index
        if (gravityGateExitCrossing(before, current, gate, 0.3)?.insideOpening) {
          expect(current.x).toBeGreaterThan(before.x)
          exitAt = index
        }
      }
      expect(enteredAt).toBeGreaterThan(0)
      expect(lowerAt).toBeGreaterThan(enteredAt)
      expect(exitAt).toBeGreaterThan(lowerAt)
      expect(scene.scene.getObjectByName('gravity-gate-height-guide')!.userData.levelHeightsM).toEqual([4, 9, 14])
    } finally { scene.dispose() }
  })

  it('changes gravity guidance through eight stages without moving or hiding physical beams or opening references', () => {
    const scene = createFlightScene()
    try {
      scene.setLessonTarget('gravity-gate')
      scene.scene.updateMatrixWorld(true)
      const frame = scene.scene.getObjectByName('gravity-gate-physical-frame')!
      const frameMatrix = frame.matrixWorld.clone()
      const drone = scene.drone.matrixWorld.clone()
      const anchors = scene.sceneReferences.map(({ id, positionM }) => ({ id, positionM: { ...positionM } }))
      const topGuide = scene.getReference('gravity-gate-top-entry')!.object
      const sideGuide = scene.getReference('gravity-gate-side-exit')!.object
      const topMatrix = topGuide.matrixWorld.clone()
      const sideMatrix = sideGuide.matrixWorld.clone()
      const accent = scene.scene.getObjectByName('gravity-gate-stage-guidance')!
      const ring = scene.scene.getObjectByName('gravity-gate-stage-reference') as THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>
      const topOpening = scene.scene.getObjectByName('gravity-gate-top-opening-guide') as THREE.LineLoop<THREE.BufferGeometry, THREE.LineDashedMaterial>
      const sideOpening = scene.scene.getObjectByName('gravity-gate-side-opening-guide') as THREE.LineLoop<THREE.BufferGeometry, THREE.LineDashedMaterial>
      for (let stage = 0; stage <= 8; stage += 1) {
        scene.setGravityGateStage(stage)
        scene.scene.updateMatrixWorld(true)
        expect(accent.visible).toBe(true)
        expect(ring.material.color.getHex()).toBe(stage >= 8 ? 0xb8f36b : stage >= 4 && stage <= 5 ? 0xffc978 : 0x45d7f7)
        expect(topOpening.material.opacity).toBe(stage >= 4 && stage <= 5 ? 1 : 0.65)
        expect(sideOpening.material.opacity).toBe(stage >= 6 ? 1 : 0.65)
        expect(frame.visible).toBe(true)
        expect(frame.children.every(({ visible }) => visible)).toBe(true)
        expect(frame.matrixWorld.equals(frameMatrix)).toBe(true)
        expect(topGuide.matrixWorld.equals(topMatrix)).toBe(true)
        expect(sideGuide.matrixWorld.equals(sideMatrix)).toBe(true)
        expect(scene.drone.matrixWorld.equals(drone)).toBe(true)
      }
      for (const stage of [null, -1, 9, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        scene.setGravityGateStage(stage)
        expect(accent.visible).toBe(false)
        expect(frame.visible).toBe(true)
        expect(frame.children.every(({ visible }) => visible)).toBe(true)
        expect(topGuide.visible).toBe(true)
        expect(sideGuide.visible).toBe(true)
      }
      expect(scene.sceneReferences.map(({ id, positionM }) => ({ id, positionM }))).toEqual(anchors)
    } finally { scene.dispose() }
  })

  it('disposes gravity beams, shared steel and both open-face guides exactly once', () => {
    const scene = createFlightScene()
    const resources = new Set<THREE.BufferGeometry | THREE.Material>()
    scene.getReference('gravity-gate-frame')!.object.traverse((object) => {
      const visual = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
      if (visual.geometry) resources.add(visual.geometry)
      for (const resource of Array.isArray(visual.material) ? visual.material : visual.material ? [visual.material] : []) resources.add(resource)
    })
    const disposals = [...resources].map((resource) => vi.spyOn(resource, 'dispose'))
    scene.dispose()
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce()
  })

})
