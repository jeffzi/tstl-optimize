function mul(x)
    return x * x
end
hp = 50
maxHp = 100
t = 0.5
offset = 10
displayHp = (hp + (maxHp - hp) * t)
flipped = (-offset)
stats = {atk = {base = 100}}
atkSquared = mul(stats.atk.base)
playerHp = 75
do
    local msg = "hp: " .. tostring(playerHp)
    print(msg)
end
a = 10
local r
do
    local y = a + 1
    r = y * 2
end
function caller()
    local y = a + 1
    return y * 2
end
local ____inline_result_25
do
    local pos = {x = a, y = a + 10}
    ____inline_result_25 = pos
end
local x = ____inline_result_25.x
local y = ____inline_result_25.y
local ____inline_result_32
do
    local hi = a + 100
    ____inline_result_32 = {a, hi}
end
local lo, hi = unpack(____inline_result_32, 1, 2)
local ____inline_result_37
local ____inline_result_38
local ____inline_arg_42 = hp
local ____inline_arg_43 = maxHp
do
    local tmp = ____inline_arg_42
    ____inline_result_37, ____inline_result_38 = ____inline_arg_43, tmp
end
local s1, s2 = ____inline_result_37, ____inline_result_38
local ____inline_result_44
do
    local label
    repeat
        local ____switch11 = playerHp
        local ____cond11 = ____switch11 == 0
        if ____cond11 then
            label = "zero"
            break
        end
        ____cond11 = ____cond11 or ____switch11 == 1
        if ____cond11 then
            label = "one"
            break
        end
        do
            label = "other"
            break
        end
    until true
    ____inline_result_44 = label
end
local label = ____inline_result_44
function double(x)
    return x * 2
end
doubled = double(hp)
function addPair(____bindingPattern0)
    local db, da
    da = ____bindingPattern0.a
    db = ____bindingPattern0.b
    return da + db
end
sum = addPair({a = 1, b = 2})
print(displayHp)
print(flipped)
print(atkSquared)
print(doubled)
print(r)
print(caller())
print(x, y)
print(lo, hi)
print(s1, s2)
print(label)
print(sum)
