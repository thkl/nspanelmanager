import esphome.codegen as cg
from esphome.components import sensor
import esphome.config_validation as cv
from esphome.const import CONF_QOS, CONF_TOPIC

from . import panel_mqtt_ns

DEPENDENCIES = ["mqtt"]

DynamicMqttSensor = panel_mqtt_ns.class_("DynamicMqttSensor", sensor.Sensor, cg.Component)

CONFIG_SCHEMA = (
    sensor.sensor_schema(DynamicMqttSensor, accuracy_decimals=1)
    .extend(
        {
            cv.Required(CONF_TOPIC): cv.string,
            cv.Optional(CONF_QOS, default=0): cv.mqtt_qos,
        }
    )
    .extend(cv.COMPONENT_SCHEMA)
)


async def to_code(config):
    var = await sensor.new_sensor(config)
    await cg.register_component(var, config)
    cg.add(var.set_topic_suffix(config[CONF_TOPIC]))
    cg.add(var.set_qos(config[CONF_QOS]))
