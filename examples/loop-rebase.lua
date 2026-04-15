posX = {0, 10, 20}
posY = {0, 5, 15}
velX = {1, 2, 3}
velY = {4, 5, 6}
count = 3
dt = 0.5
for i = 1, count do
    posX[i] = posX[i] + velX[i] * dt
    posY[i] = posY[i] + velY[i] * dt
end
indices = {}
for i = 0, count - 1 do
    indices[i + 1] = i
end
print(posX[1], posX[2], posX[3])
print(posY[1], posY[2], posY[3])
print(indices[1], indices[2], indices[3])
