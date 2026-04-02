hp = 50
maxHp = 100
t = 0.5
offset = 10
displayHp = (hp + (maxHp - hp) * t)
flipped = (-offset)
atkSquared = (stats.atk.base * stats.atk.base)
playerHp = 75
local ____inline_arg_0 = "hp"
local ____inline_arg_1 = playerHp
do
    local msg = (____inline_arg_0 .. ": ") .. tostring(____inline_arg_1)
    console:log(msg)
end
a = 10
local r
local ____inline_arg_0 = a
do
    local y = ____inline_arg_0 + 1
    r = y * 2
end
function caller()
    local ____inline_arg_0 = a
    local y = ____inline_arg_0 + 1
    return y * 2
end
local ____inline_result_28
local ____inline_arg_0 = a
do
    local pos = {x = ____inline_arg_0, y = ____inline_arg_0 + 10}
    ____inline_result_28 = pos
end
local x = ____inline_result_28.x
local y = ____inline_result_28.y
local ____inline_result_36
local ____inline_arg_0 = a
do
    local hi = ____inline_arg_0 + 100
    ____inline_result_36 = {____inline_arg_0, hi}
end
local lo, hi = unpack(____inline_result_36, 1, 2)
local ____inline_result_42
local ____inline_result_43
local ____inline_arg_0 = hp
local ____inline_arg_1 = maxHp
do
    local tmp = ____inline_arg_0
    ____inline_result_42, ____inline_result_43 = ____inline_arg_1, tmp
end
local s1, s2 = ____inline_result_42, ____inline_result_43
local ____inline_result_49
local ____inline_arg_0 = playerHp
do
    local label
    repeat
        local ____switch10 = ____inline_arg_0
        local ____cond10 = ____switch10 == 0
        if ____cond10 then
            label = "zero"
            break
        end
        ____cond10 = ____cond10 or ____switch10 == 1
        if ____cond10 then
            label = "one"
            break
        end
        do
            label = "other"
            break
        end
    until true
    ____inline_result_49 = label
end
local label = ____inline_result_49
function double(x)
    return x * 2
end
doubled = double(hp)
sum = addPair({a = 1, b = 2})
print(displayHp)
print(flipped)
print(atkSquared)
print(doubled)
print(r)
print(x, y)
print(lo, hi)
print(s1, s2)
print(label)
print(sum)
