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
function clampedAdd(a, b)
    local sum = a + b
    return sum > 100 and 100 or sum
end
total = clampedAdd(hp, 30)
print(displayHp)
print(flipped)
print(doubled)
print(total)
