posX = {0, 10, 20}
velX = {1, 2, 3}
count = 3
dt = 0.5
for i = 1, count do
    posX[i] = posX[i] + velX[i] * dt
end
counts = {0, 0, 0}
for i = 1, count do
    counts[i] = counts[i] + 1
end
obj = {arr = {0, 0, 0}}
for i = 1, count do
    local ____obj_arr_4, ____temp_5 = obj.arr, i
    ____obj_arr_4[____temp_5] = ____obj_arr_4[____temp_5] + velX[i] * dt
end
function nextIndex(i)
    return i
end
brr = {0, 0, 0}
for i = 0, count - 1 do
    local ____brr_6, ____temp_7 = brr, nextIndex(i) + 1
    ____brr_6[____temp_7] = ____brr_6[____temp_7] + velX[i + 1]
end
print(posX[1], posX[2], posX[3])
print(counts[1], counts[2], counts[3])
print(obj.arr[1], obj.arr[2], obj.arr[3])
print(brr[1], brr[2], brr[3])
