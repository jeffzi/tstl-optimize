x = 10
y = 20
targetX = 100
targetY = 200
speed = 5
maxSpeed = 10
dx = targetX - x
dy = targetY - y
dist = (dx * dx + dy * dy) ^ 0.5
tileX = x / 32 - x / 32 % 1
tileY = y / 32 - y / 32 % 1
absX = dx < 0 and -(dx) or dx
absY = dy < 0 and -(dy) or dy
clamped = speed < maxSpeed and speed or maxSpeed
bounded = 0 > speed and 0 or speed
cubed = x ^ 3
biggest = math.max(x, y, speed)
print(dist)
print(tileX, tileY)
print(absX, absY)
print(clamped, bounded)
print(cubed)
print(biggest)
