config = {physics = {gravity = 9.8, friction = 0.98}}
posX = {0, 10}
posY = {0, 5}
velX = {1, 2}
velY = {0, 0}
count = 2
dt = 0.5
local ____config_physics_friction = config.physics.friction
for i = 1, count do
    local ____velX = velX[i]
    local ____velY = velY[i]
    ____velX = ____velX * ____config_physics_friction
    ____velY = ____velY + config.physics.gravity * dt
    ____velY = ____velY * ____config_physics_friction
    posX[i] = posX[i] + ____velX * dt
    posY[i] = posY[i] + ____velY * dt
    velX[i] = ____velX
    velY[i] = ____velY
end
terminalSpeed = config.physics.gravity / config.physics.friction
drag = {1, 0.9}
function applyDrag(i)
    drag[i + 1] = drag[i + 1] * 0.5
end
for i = 0, count - 1 do
    drag[i + 1] = drag[i + 1] * config.physics.friction
    applyDrag(i)
end
print(posX[1], posY[1])
print(terminalSpeed)
print(drag[1], drag[2])
