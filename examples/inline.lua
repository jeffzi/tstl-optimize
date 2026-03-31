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
function double(x)
    return x * 2
end
doubled = double(hp)
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
print(displayHp)
print(flipped)
print(doubled)
