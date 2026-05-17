local ____math_huge = math.huge
local ____math_max = math.max
x = 10
y = 20
targetX = 100
targetY = 200
speed = 5
maxSpeed = 10
dx = targetX - x
dy = targetY - y
dist = (dx * dx + dy * dy) ^ 0.5
tileX = (x * 0.03125 == ____math_huge or x * 0.03125 == -(____math_huge)) and math.floor(x * 0.03125) or x * 0.03125 - x * 0.03125 % 1
tileY = (y * 0.03125 == ____math_huge or y * 0.03125 == -(____math_huge)) and math.floor(y * 0.03125) or y * 0.03125 - y * 0.03125 % 1
absX = dx == 0 and 0 or (dx < 0 and -(dx) or dx)
absY = dy == 0 and 0 or (dy < 0 and -(dy) or dy)
clamped = math.min(speed, maxSpeed)
bounded = ____math_max(0, speed)
cubed = x * x * x
maxLit = false and 2 or 3
minLit = true and 1 or 2
biggest = ____math_max(x, y, speed)
print(dist)
print(tileX, tileY)
print(absX, absY)
print(clamped, bounded)
print(maxLit, minLit)
print(cubed)
print(biggest)
