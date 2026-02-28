// Example OpenSCAD file — a rounded cube with cylindrical holes
// Run: npx openscad-viewer samples/example.scad

$fn = 32;

difference() {
    // Rounded base block
    minkowski() {
        cube([20, 20, 10], center = true);
        sphere(r = 2);
    }

    // Hole through the top
    cylinder(h = 20, r = 4, center = true);

    // Hole through the front
    rotate([90, 0, 0])
        cylinder(h = 30, r = 3, center = true);

    // Hole through the side
    rotate([0, 90, 0])
        cylinder(h = 30, r = 3, center = true);
}
