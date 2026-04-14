function basicMerge()
    local a, b, c = 1, 2, 3
    return a + b + c
end
function withNil()
    local x, y = 10, nil
    y = x + 1
    return y
end
function forwardRef()
    local a = 1
    local b = a + 1
    return b
end
function closureCapture()
    local a = 1
    local function f()
        return a
    end
    return f
end
function impure()
    local a = 1
    local b = compute()
    return a + b
end
x = 1
y = 2
print(basicMerge())
print(withNil())
print(forwardRef())
print(closureCapture()())
print(impure())
print(x + y)
