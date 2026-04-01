function lerp(a, b, t)
    return a + (b - a) * t
end
negate = function(x) return -x end
hp = 50
maxHp = 100
t = 0.5
offset = 10
displayHp = (hp + (maxHp - hp) * t)
flipped = (-offset)
function debugLog(prefix, value)
    local msg = (prefix .. ": ") .. tostring(value)
    console.log(msg)
end
playerHp = 75
local ____inline_arg_0 = "hp"
local ____inline_arg_1 = playerHp
do
    local msg = (____inline_arg_0 .. ": ") .. tostring(____inline_arg_1)
    console.log(msg)
end
function compute(x)
    local y = x + 1
    return y * 2
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
function getPos(x)
    local pos = {x = x, y = x + 10}
    return pos
end
local ____inline_result_31
local ____inline_arg_0 = a
do
    local pos = {x = ____inline_arg_0, y = ____inline_arg_0 + 10}
    ____inline_result_31 = pos
end
local x = ____inline_result_31.x
local y = ____inline_result_31.y
function double(x)
    return x * 2
end
doubled = double(hp)
print(displayHp)
print(flipped)
print(doubled)
print(r)
print(x, y)
